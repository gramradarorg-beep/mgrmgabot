// MGRMGA trade bot — постит покупки/продажи токена в TG-канал с весёлым сопровождением.
// Данные берём из TonAPI (он декодирует JettonSwap), шлём в Telegram Bot API. Без внешних зависимостей.
//
// Запуск:  node index.mjs           (боевой цикл опроса пула)
//          node index.mjs --test    (отправить тестовую покупку и продажу в канал и выйти)
//
// Конфиг — в файле .env рядом (см. .env.example).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUY, SELL, pick, tierFor } from "./phrases.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(DIR, "state.json");

// ---------- крошечный загрузчик .env (без зависимостей) ----------
// Читаем ФАЙЛ .env заново каждый раз — правки подхватываются без перезапуска бота.
function readEnvFile() {
  const f = path.join(DIR, ".env");
  const out = {};
  if (!fs.existsSync(f)) return out;
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

const CFG = {};
function refreshConfig() {
  // Приоритет у файла .env; если переменная задана снаружи (process.env) — берём её как запасной вариант.
  const f = readEnvFile();
  const get = (k, d = "") => (f[k] ?? process.env[k] ?? d);
  CFG.botToken = get("TELEGRAM_BOT_TOKEN");
  CFG.channel = get("CHANNEL_ID");
  CFG.tonapiKey = get("TONAPI_KEY");
  CFG.pool = get("POOL_ADDRESS");
  CFG.jetton = get("JETTON_MASTER");
  CFG.symbol = get("TOKEN_SYMBOL", "MGRMGA").toUpperCase();
  CFG.buyLink = get("BUY_LINK", "https://mgrmga.org");
  CFG.minTon = Number(get("MIN_TON", "0"));
  CFG.pollMs = Math.max(5000, Number(get("POLL_INTERVAL_MS", "15000")));
  CFG.seedPost = get("SEED_POST") === "1";
}
refreshConfig();

const TONAPI = "https://tonapi.io/v2";

// ---------- состояние (что уже отправляли) ----------
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { seen: [], lastTs: 0, seeded: false };
  }
}
function saveState(s) {
  // держим не больше 500 последних id — файл не растёт бесконечно
  s.seen = s.seen.slice(-500);
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// ---------- утилиты ----------
const nf = (n, max = 2) =>
  Number(n).toLocaleString("ru-RU", { maximumFractionDigits: max, minimumFractionDigits: 0 });

function shortAddr(a) {
  if (!a) return "аноним";
  const s = a.includes(":") ? a.split(":")[1] : a;
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function emojiBar(ton, buy) {
  const n = Math.min(24, Math.max(1, Math.round(ton)));
  return (buy ? "🟢" : "🔴").repeat(n);
}

async function tonUsd() {
  try {
    const r = await fetch(`${TONAPI}/rates?tokens=ton&currencies=usd`, { headers: authHeaders() });
    const j = await r.json();
    return Number(j?.rates?.TON?.prices?.USD) || 0;
  } catch {
    return 0;
  }
}

// Цена токена, изменение за 24ч и объём — из DEX Screener (живые данные по пулу).
// TonAPI для свежего токена отдаёт заглушку ($0.0000001, всегда 0.00%), поэтому не годится.
async function tokenRate() {
  if (!CFG.pool) return null;
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/pairs/ton/${CFG.pool}`);
    const j = await r.json();
    let p = j.pairs || j.pair;
    if (Array.isArray(p)) p = p[0];
    if (!p) return null;
    const usd = Number(p.priceUsd) || 0;
    const h24 = p.priceChange?.h24;
    const diff = h24 === undefined || h24 === null ? "" : `${h24}%`;
    const vol24 = Number(p.volume?.h24) || 0;
    return { usd, diff, vol24 };
  } catch {
    return null;
  }
}

// Форматирование крошечных цен мем-коина: $0.000000123
function fmtPrice(p) {
  if (!p) return "";
  if (p >= 1) return `$${nf(p, 4)}`;
  const s = p.toFixed(12).replace(/0+$/, "");
  return `$${s}`;
}

// «▲ 5.2%» / «▼ 3.1%» из строки вида "+5.2%" или "-3.1%"
function fmtDiff(diff) {
  if (!diff) return "";
  const neg = diff.trim().startsWith("-");
  const val = diff.replace(/[+\-\s]/g, "");
  return `${neg ? "▼" : "▲"} ${val}`;
}

function authHeaders() {
  return CFG.tonapiKey ? { Authorization: `Bearer ${CFG.tonapiKey}` } : {};
}

// ---------- Telegram ----------
async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${CFG.botToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`Telegram ${method}: ${j.error_code} ${j.description}`);
  return j.result;
}

function buildMessage({ kind, ton, tokens, usd, user, txId, rate }) {
  const buy = kind === "buy";
  const tier = buy ? tierFor(ton) : tierFor(ton) === "whale" ? "dump" : tierFor(ton);
  const phrase = pick(buy ? BUY[tier] : SELL[tier]);
  const head = buy ? `🟢 <b>${CFG.symbol} — ПОКУПКА</b>` : `🔴 <b>${CFG.symbol} — ПРОДАЖА</b>`;
  const usdStr = usd ? ` (~$${nf(ton * usd, 0)})` : "";
  const userLink = user ? `<a href="https://tonviewer.com/${user}">${shortAddr(user)}</a>` : "аноним";
  const txLink = txId ? `<a href="https://tonviewer.com/transaction/${txId}">🔗 Транзакция</a>` : "";
  const buyLink = `<a href="${CFG.buyLink}">Купить ${CFG.symbol}</a>`;

  // Строка цены токена + изменение за 24ч + объём (из DEX Screener).
  let priceLine = null;
  let volLine = null;
  if (rate && rate.usd) {
    const d = fmtDiff(rate.diff);
    priceLine = `📊 Цена ${CFG.symbol}: ${fmtPrice(rate.usd)}${d ? `  (${d} за 24ч)` : ""}`;
    if (rate.vol24) volLine = `📈 Объём 24ч: $${nf(rate.vol24, 0)}`;
  }

  return [
    head,
    `<i>${phrase}</i>`,
    "",
    `💵 <b>${nf(ton, 2)} TON</b>${usdStr}`,
    `🪙 ${nf(tokens, 0)} ${CFG.symbol}`,
    emojiBar(ton, buy),
    priceLine,
    volLine,
    `👤 ${userLink}`,
    [txLink, buyLink].filter(Boolean).join(" · "),
  ].filter((l) => l !== null).join("\n");
}

async function post(evt) {
  const text = buildMessage(evt);
  await tg("sendMessage", {
    chat_id: CFG.channel,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}

// ---------- разбор свапов из TonAPI ----------
function parseSwaps(events) {
  const out = [];
  for (const ev of events) {
    for (const act of ev.actions || []) {
      if (act.type !== "JettonSwap" || (act.status && act.status !== "ok")) continue;
      const s = act.JettonSwap;
      if (!s) continue;
      const symIn = s.jetton_master_in?.symbol?.toUpperCase();
      const symOut = s.jetton_master_out?.symbol?.toUpperCase();
      let kind, ton, tokens;

      if (symOut === CFG.symbol) {
        // получили наш токен -> покупка (заплатили TON)
        kind = "buy";
        ton = Number(s.ton_in || 0) / 1e9;
        tokens = Number(s.amount_out || 0) / 10 ** (s.jetton_master_out?.decimals ?? 9);
      } else if (symIn === CFG.symbol) {
        // отдали наш токен -> продажа (получили TON)
        kind = "sell";
        ton = Number(s.ton_out || 0) / 1e9;
        tokens = Number(s.amount_in || 0) / 10 ** (s.jetton_master_in?.decimals ?? 9);
      } else {
        continue; // свап не про наш токен
      }

      out.push({
        id: ev.event_id,
        ts: ev.timestamp || 0,
        kind,
        ton,
        tokens,
        user: s.user_wallet?.address || "",
        txId: ev.event_id,
      });
    }
  }
  return out;
}

async function fetchEvents() {
  const url = `${TONAPI}/accounts/${CFG.pool}/events?limit=50`;
  const r = await fetch(url, { headers: authHeaders() });
  if (!r.ok) throw new Error(`TonAPI events ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return j.events || [];
}

// ---------- основной цикл ----------
async function tick(state, ctx) {
  const events = await fetchEvents();
  const swaps = parseSwaps(events)
    .filter((s) => !state.seen.includes(s.id))
    .filter((s) => s.ton >= CFG.minTon)
    .sort((a, b) => a.ts - b.ts); // старые -> новые, чтобы порядок в канале был хронологический

  for (const s of swaps) {
    try {
      await post({ ...s, usd: ctx.usd, rate: ctx.rate });
      console.log(`[${new Date().toISOString()}] ${s.kind.toUpperCase()} ${nf(s.ton, 2)} TON — отправлено`);
    } catch (e) {
      console.error("Ошибка отправки:", e.message);
    }
    state.seen.push(s.id);
    state.lastTs = Math.max(state.lastTs, s.ts);
    saveState(state);
    await new Promise((r) => setTimeout(r, 400)); // не долбим Telegram
  }
  // всё, что видели в этом опросе, помечаем как известное (даже если ниже порога)
  for (const ev of events) if (!state.seen.includes(ev.event_id)) state.seen.push(ev.event_id);
  saveState(state);
}

function requireCfg() {
  const miss = [];
  if (!CFG.botToken) miss.push("TELEGRAM_BOT_TOKEN");
  if (!CFG.channel) miss.push("CHANNEL_ID");
  if (miss.length) {
    console.error("Не хватает переменных в .env: " + miss.join(", "));
    process.exit(1);
  }
}

async function testPost() {
  requireCfg();
  const usd = await tonUsd();
  const rate = await tokenRate(); // если пул есть — будет реальная цена; нет — строка цены просто не покажется
  console.log("Отправляю тестовую покупку и продажу...");
  await post({ kind: "buy", ton: 42.5, tokens: 1_250_000, usd, rate, user: "0:abc123def4567890abcdef1234567890abcdef1234567890abcdef1234567890", txId: "97b3f0e5c1a24d6e8f0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f" });
  await new Promise((r) => setTimeout(r, 600));
  await post({ kind: "sell", ton: 130, tokens: 3_800_000, usd, rate, user: "0:9999aaaa8888bbbb7777cccc6666dddd5555eeee4444ffff3333000011112222", txId: "12ab34cd56ef7890a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718" });
  console.log("Готово — проверь канал.");
}

async function main() {
  if (process.argv.includes("--test")) return testPost();

  requireCfg();
  if (!CFG.tonapiKey) console.warn("⚠  TONAPI_KEY не задан — TonAPI будет резать по лимиту без ключа.");

  // Ждём адрес пула: можно вписать POOL_ADDRESS в .env уже на работающем боте — подхватится сам.
  while (!CFG.pool) {
    console.log("Жду POOL_ADDRESS в .env (адрес пула MGRMGA/TON). Впиши его — подхвачу без перезапуска...");
    await new Promise((r) => setTimeout(r, 10_000));
    refreshConfig();
  }

  const state = loadState();
  const ctx = { usd: await tonUsd(), rate: await tokenRate() };
  // курс TON и цену токена обновляем раз в минуту
  setInterval(async () => {
    ctx.usd = (await tonUsd()) || ctx.usd;
    ctx.rate = (await tokenRate()) || ctx.rate;
  }, 60_000);

  // первый запуск: помечаем всю историю как «видели», чтобы не спамить старыми сделками
  if (!state.seeded && !CFG.seedPost) {
    const events = await fetchEvents();
    for (const ev of events) state.seen.push(ev.event_id);
    state.seeded = true;
    saveState(state);
    console.log(`Стартовая синхронизация: ${events.length} событий помечены как известные. Ждём новые сделки.`);
  } else {
    state.seeded = true;
    saveState(state);
  }

  console.log(`Бот запущен. Пул: ${CFG.pool}. Опрос каждые ${CFG.pollMs / 1000}с. Канал: ${CFG.channel}.`);
  const run = () => {
    refreshConfig(); // подхватываем правки .env на лету (порог, пул, ссылки)
    return tick(state, ctx).catch((e) => console.error("Ошибка опроса:", e.message));
  };
  await run();
  setInterval(run, CFG.pollMs);
}

main().catch((e) => { console.error(e); process.exit(1); });
