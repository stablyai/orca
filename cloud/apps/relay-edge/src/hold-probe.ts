// Staging-only socket hold probe: how long a WebSocket survives from a given network, through the
// front door and direct. On only with HOLD_PROBE === '1' (absent: these paths are 404, as any
// unknown path, and SpliceRelay refuses the 'hold' kind).
//   GET /__probe/page              static page that keeps 3 sockets open per path and redials.
//   GET /__probe/hold/<sessionId>  WebSocket, held in a Durable Object as desktops' sockets are:
//     SpliceRelay `hold:<sessionId>` (a splice object is `<relayHostId>.<slot>`, never with ':'),
//     so both paths of one session end in the same object and no new class (or migration) is
//     needed. The object pings 'p:<n>' every 25 s from its alarm and the page echoes it; 75 s
//     without a frame closes 4408 (PEER_DROPPED), as HostRelay does for a silent control.
// The page's first frame on a redialled socket reports how the previous one ended from its side
// ('c:<ageSeconds>:<code>'), which covers sockets whose server end never saw a close (a reset).
import type { Env } from './env'
import type { Ingress } from './ingress'
import { metric, requestPlace } from './metrics'
import { admitPreAuth } from './preauth'
import { NO_DEADLINE } from './splice-state'

export const HOLD_PING_MS = 25_000
export const HOLD_SILENCE_MS = 75_000
export const HOLD_SILENCE_CODE = 4408
export const HOLD_OBJECT_PREFIX = 'hold:'
const SESSION_ID = /^[A-Za-z0-9]{8,32}$/
const CLIENT_CLOSE = /^c:(\d{1,7}):(\d{1,4}|error)$/
const TAG = 'hold'

type HoldPath = 'front' | 'direct'
type HoldAttachment = { hold: 1; sid: string; path: HoldPath; place: string; openedAt: number; lastSeen: number; lastPingAt: number; pings: number; ended?: true }

export function holdProbeEnabled(env: Env): boolean {
  return env.HOLD_PROBE === '1'
}

// ---------------- Worker side ----------------

export async function holdProbe(env: Env, request: Request, ingress: Ingress | null, pathname: string): Promise<Response | null> {
  if (!holdProbeEnabled(env)) { return null }
  if (pathname === '/__probe/page') {
    if (request.method !== 'GET') { return new Response(null, { status: 405 }) }
    return new Response(probePage(env, request), {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
    })
  }
  const hold = pathname.match(/^\/__probe\/hold\/([^/]+)$/)
  if (!hold) { return null }
  const sid = hold[1]!
  if (!SESSION_ID.test(sid)) { return new Response(null, { status: 400 }) }
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') { return new Response(null, { status: 426 }) }
  if (!(await admitPreAuth(env, request, 'hold', ingress))) { return new Response(null, { status: 429 }) }
  // Only what the object needs: none of the client's headers reach it.
  const headers = new Headers({
    upgrade: 'websocket',
    'x-edge-kind': TAG,
    'x-edge-hold': JSON.stringify({ sid, path: ingress ? 'front' : 'direct', place: requestPlace(request, ingress) })
  })
  return env.SPLICE_RELAY.get(env.SPLICE_RELAY.idFromName(HOLD_OBJECT_PREFIX + sid)).fetch(new Request(request.url, { headers }))
}

// ---------------- object side (SpliceRelay delegates here for 'hold' sockets) ----------------

export function holdAccept(ctx: DurableObjectState, env: Env, request: Request): Response {
  let meta: { sid?: unknown; path?: unknown; place?: unknown }
  try { meta = JSON.parse(request.headers.get('x-edge-hold') ?? '') } catch { meta = {} }
  const { sid, path, place } = meta
  if (!holdProbeEnabled(env) || typeof sid !== 'string' || !SESSION_ID.test(sid) || (path !== 'front' && path !== 'direct')) {
    return new Response(null, { status: 404 })
  }
  const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket]
  ctx.acceptWebSocket(server, [TAG])
  const now = Date.now()
  const a: HoldAttachment = { hold: 1, sid, path, place: typeof place === 'string' ? place : '', openedAt: now, lastSeen: now, lastPingAt: now, pings: 0 }
  server.serializeAttachment(a)
  metric(env, 'hold_open', 1, a.path, [], '', a.place, a.sid)
  return new Response(null, { status: 101, webSocket: client })
}

export function isHoldSocket(ctx: DurableObjectState, ws: WebSocket): boolean {
  return ctx.getTags(ws)[0] === TAG
}

export function holdMessage(env: Env, ws: WebSocket, message: string | ArrayBuffer): void {
  const a = attachment(ws)
  if (!a || a.ended) { return }
  a.lastSeen = Date.now()
  ws.serializeAttachment(a)
  const report = typeof message === 'string' ? message.match(CLIENT_CLOSE) : null
  if (report) { metric(env, 'hold_client_close', Number(report[1]), a.path, [], report[2]!, a.place, a.sid) }
}

// Close or error from the client side; once per socket.
export function holdGone(env: Env, ws: WebSocket, code: string): void {
  const a = attachment(ws)
  if (!a || a.ended) { return }
  end(env, ws, a, code)
  try { ws.close() } catch {}
}

// From the object's alarm: ping each socket due, close the silent ones.
export function holdTick(ctx: DurableObjectState, env: Env, now = Date.now()): void {
  for (const ws of ctx.getWebSockets(TAG)) {
    const a = attachment(ws)
    if (!a || a.ended) { continue }
    if (now - a.lastSeen > HOLD_SILENCE_MS) {
      end(env, ws, a, String(HOLD_SILENCE_CODE))
      try { ws.close(HOLD_SILENCE_CODE, 'silent') } catch {}
      continue
    }
    if (now - a.lastPingAt >= HOLD_PING_MS - 50) {
      a.lastPingAt = now
      try { ws.send(`p:${++a.pings}`) } catch {}
      ws.serializeAttachment(a)
    }
  }
}

// The next ping due among the object's hold sockets (NO_DEADLINE when it holds none).
export function holdNextAlarm(ctx: DurableObjectState): number {
  let next = NO_DEADLINE
  for (const ws of ctx.getWebSockets(TAG)) {
    const a = attachment(ws)
    if (a && !a.ended) { next = Math.min(next, a.lastPingAt + HOLD_PING_MS) }
  }
  return next
}

function end(env: Env, ws: WebSocket, a: HoldAttachment, code: string): void {
  a.ended = true
  try { ws.serializeAttachment(a) } catch {}
  metric(env, 'hold_close', Math.round((Date.now() - a.openedAt) / 1000), a.path, [a.pings], code, a.place, a.sid)
}

function attachment(ws: WebSocket): HoldAttachment | null {
  try {
    const a = ws.deserializeAttachment() as HoldAttachment | null
    return a?.hold === 1 ? a : null
  } catch {
    return null
  }
}

// The two hosts the page dials: the front door (the first token-mode origin) and the edge itself.
// Behind the front door the Worker still sees its own hostname, so request.url names the edge.
function probePage(env: Env, request: Request): string {
  const front = (env.INGRESS_ORIGINS ?? '').split(',')[0]?.trim() ?? ''
  const targets: [string, string][] = [['direct', `wss://${new URL(request.url).host}`]]
  if (front.startsWith('https://')) { targets.unshift(['front', `wss://${front.slice('https://'.length)}`]) }
  return PAGE.replace('__TARGETS__', JSON.stringify(targets))
}

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connection test / 连接测试</title>
<style>body{font:15px system-ui,sans-serif;margin:24px;max-width:720px}table{border-collapse:collapse;margin-top:12px}
td,th{border:1px solid #ccc;padding:6px 10px;text-align:right}th:first-child,td:first-child{text-align:left}.big{font-size:20px;font-weight:600}</style>
</head><body>
<p class="big">Please keep this page open. 请保持此页面打开。</p>
<p>This page measures how long connections stay up. You do not need to do anything; leave the tab open (screen may sleep). 本页面测试连接能保持多久，无需任何操作，保持标签页打开即可。</p>
<p>Session / 会话: <b id="sid"></b> &middot; running / 已运行 <b id="up">0s</b></p>
<table><thead><tr><th>Path / 线路</th><th>Open / 在线</th><th>Drops / 断开</th><th>Last code / 最近代码</th><th>Oldest / 最长</th></tr></thead><tbody id="rows"></tbody></table>
<script>
(function () {
  var TARGETS = __TARGETS__, PER_PATH = 3, SILENCE_MS = 75000, REDIAL_MS = 2000
  var abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', sid = ''
  var rnd = crypto.getRandomValues(new Uint8Array(16))
  for (var i = 0; i < rnd.length; i++) sid += abc[rnd[i] % abc.length]
  document.getElementById('sid').textContent = sid
  var started = Date.now(), stats = {}
  function fmt(s) { s = Math.floor(s); return s >= 3600 ? Math.floor(s / 3600) + 'h' + Math.floor(s % 3600 / 60) + 'm' : s >= 60 ? Math.floor(s / 60) + 'm' + s % 60 + 's' : s + 's' }
  function dial(path, url, slot, report) {
    var st = stats[path], ws, opened = 0, last = 0, done = false
    try { ws = new WebSocket(url + '/__probe/hold/' + sid) } catch (e) { setTimeout(function () { dial(path, url, slot, report) }, REDIAL_MS); return }
    function finish(code) {
      if (done) return
      done = true
      clearInterval(watch)
      if (opened) { st.open--; delete st.ages[slot] }
      st.drops++; st.last = code
      var age = opened ? Math.round((Date.now() - opened) / 1000) : 0
      setTimeout(function () { dial(path, url, slot, 'c:' + age + ':' + code) }, REDIAL_MS)
    }
    var watch = setInterval(function () {
      if (opened && Date.now() - last > SILENCE_MS) { try { ws.close(4408) } catch (e) {} finish(4408) }
    }, 5000)
    ws.onopen = function () { opened = last = Date.now(); st.open++; st.ages[slot] = opened; if (report) ws.send(report) }
    ws.onmessage = function (e) { last = Date.now(); if (typeof e.data === 'string' && e.data.indexOf('p:') === 0) ws.send(e.data) }
    ws.onclose = function (e) { finish(e.code || 1006) }
  }
  TARGETS.forEach(function (t) {
    stats[t[0]] = { open: 0, drops: 0, last: '-', ages: {} }
    for (var s = 0; s < PER_PATH; s++) dial(t[0], t[1], s, '')
  })
  setInterval(function () {
    var now = Date.now(), html = ''
    document.getElementById('up').textContent = fmt((now - started) / 1000)
    TARGETS.forEach(function (t) {
      var st = stats[t[0]], oldest = 0
      for (var k in st.ages) oldest = Math.max(oldest, (now - st.ages[k]) / 1000)
      html += '<tr><td>' + t[0] + '</td><td>' + st.open + '/' + PER_PATH + '</td><td>' + st.drops + '</td><td>' + st.last + '</td><td>' + fmt(oldest) + '</td></tr>'
    })
    document.getElementById('rows').innerHTML = html
  }, 1000)
})()
</script></body></html>
`
