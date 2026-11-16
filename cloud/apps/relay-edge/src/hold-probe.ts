// Staging-only socket hold probe: how long a plain WebSocket survives from a given network, through
// the front door and direct. On only with HOLD_PROBE === '1' (absent: these paths are 404, as any
// unknown path). No object, no auth, no stored state: each socket lives in the Worker request that
// accepted it and ends as one metric.
//   GET /__probe/page              static page that keeps 3 sockets open per path and redials.
//   GET /__probe/hold/<sessionId>  WebSocket: 'p:<n>' every 25 s, the page echoes it back.
// The page's first frame on a redialled socket reports how the previous one ended from its side
// ('c:<ageSeconds>:<code>'), which covers sockets whose server end never saw a close.
import type { Env } from './env'
import type { Ingress } from './ingress'
import { metric, requestPlace } from './metrics'
import { admitPreAuth } from './preauth'

export const HOLD_PING_MS = 25_000
// No frame for this long: the socket is dead even if no close arrived (code 4408 on both sides).
export const HOLD_SILENCE_MS = 75_000
export const HOLD_SILENCE_CODE = 4408
const SESSION_ID = /^[A-Za-z0-9]{8,32}$/
const CLIENT_CLOSE = /^c:(\d{1,7}):(\d{1,4}|error)$/

export function holdProbeEnabled(env: Env): boolean {
  return env.HOLD_PROBE === '1'
}

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
  if (!SESSION_ID.test(hold[1]!)) { return new Response(null, { status: 400 }) }
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') { return new Response(null, { status: 426 }) }
  if (!(await admitPreAuth(env, request, 'hold', ingress))) { return new Response(null, { status: 429 }) }
  return holdSocket(env, hold[1]!, ingress ? 'front' : 'direct', requestPlace(request, ingress))
}

function holdSocket(env: Env, sessionId: string, path: 'front' | 'direct', place: string): Response {
  const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket]
  server.accept()
  const opened = Date.now()
  let lastFrame = opened
  let pings = 0
  let ended = false
  const age = () => Math.round((Date.now() - opened) / 1000)
  const end = (reason: string) => {
    if (ended) { return }
    ended = true
    clearInterval(timer)
    metric(env, 'hold_close', age(), path, [pings], reason, place, sessionId)
  }
  const timer = setInterval(() => {
    if (Date.now() - lastFrame > HOLD_SILENCE_MS) {
      end(String(HOLD_SILENCE_CODE))
      try { server.close(HOLD_SILENCE_CODE, 'silent') } catch {}
      return
    }
    try { server.send(`p:${++pings}`) } catch {}
  }, HOLD_PING_MS)
  server.addEventListener('message', (event) => {
    lastFrame = Date.now()
    const report = typeof event.data === 'string' ? event.data.match(CLIENT_CLOSE) : null
    if (report) { metric(env, 'hold_client_close', Number(report[1]), path, [], report[2]!, place, sessionId) }
  })
  server.addEventListener('close', (event) => {
    end(String(event.code))
    try { server.close() } catch {}
  })
  server.addEventListener('error', () => end('error'))
  metric(env, 'hold_open', 1, path, [], '', place, sessionId)
  return new Response(null, { status: 101, webSocket: client })
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
