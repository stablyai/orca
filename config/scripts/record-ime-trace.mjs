// Captures a real IME composition trace from your own machine and your own input
// method, in the exact JSON shape src/renderer/src/lib/*.test-fixtures.ts consumes.
//
// Why this exists: CDP-dispatched keystrokes bypass the OS input-method layer, so no
// amount of page.keyboard.type() produces a real composition. The Linux CI matrix
// drives ibus through X11 and covers hangul/libpinyin/anthy/unikey, but there is no
// macOS or Windows IME CI. On those platforms a human typing into this page is the
// only way to get a trace that is honestly labelled `recorded`.
//
//   pnpm ime:record
//
// Then open the printed URL, switch to the input method you want to characterize,
// type, and press Save. Everything runs on localhost and nothing is uploaded.

import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const projectDir = path.resolve(import.meta.dirname, '../..')
const outputDir = path.join(projectDir, 'test-results', 'ime-recordings')
const host = '127.0.0.1'
const port = Number(process.env.ORCA_IME_RECORDER_PORT ?? 7331)

// Kept identical to tests/e2e/terminal-ime-boundary-probe.ts so traces captured here
// and traces captured in CI deserialize through the same loader.
const RECORDED_EVENT_TYPES = [
  'compositionstart',
  'compositionupdate',
  'compositionend',
  'beforeinput',
  'input',
  'keydown',
  'keypress',
  'keyup'
]

const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Orca IME trace recorder</title>
<style>
  :root { color-scheme: dark }
  body { background:#0b0b0c; color:#e7e7ea; font:14px/1.5 ui-sans-serif,system-ui,sans-serif;
         margin:0; padding:32px; display:flex; flex-direction:column; gap:16px }
  h1 { font-size:16px; font-weight:600; margin:0 }
  p { margin:0; color:#a1a1aa; max-width:70ch }
  textarea { width:100%; height:100px; background:#161618; color:#e7e7ea; border:1px solid #2a2a2e;
             border-radius:8px; padding:12px; font:15px/1.5 ui-monospace,monospace; resize:vertical }
  input { background:#161618; color:#e7e7ea; border:1px solid #2a2a2e; border-radius:8px;
          padding:8px 12px; font:14px ui-sans-serif,system-ui,sans-serif; width:min(560px,100%) }
  .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap }
  button { background:#3b3bde; color:#fff; border:0; border-radius:8px; padding:8px 16px;
           font:600 14px ui-sans-serif,system-ui,sans-serif; cursor:pointer }
  button.secondary { background:#2a2a2e }
  #log { background:#161618; border:1px solid #2a2a2e; border-radius:8px; padding:12px;
         font:12px/1.45 ui-monospace,monospace; height:320px; overflow:auto; white-space:pre }
  #status { color:#7ee787 }
  .count { color:#a1a1aa; font-variant-numeric:tabular-nums }
</style>
</head>
<body>
  <h1>Orca IME trace recorder</h1>
  <p>
    Switch to the input method you want to characterize, then compose in the box below.
    Every composition, input and key event is captured together with the textarea's
    value and selection offsets at that exact instant — the offsets are what make a
    trace <em>recorded</em> rather than reconstructed.
  </p>
  <p>
    Type the sequence you care about, including the committing key and any candidate
    navigation. Then name it after the behavior it demonstrates and press Save.
  </p>

  <textarea id="target" autocomplete="off" autocorrect="off" spellcheck="false"
            placeholder="Compose here"></textarea>

  <div class="row">
    <input id="name" placeholder="e.g. macos-pinyin-space-selects-first-candidate" />
    <input id="committed" placeholder="text that should end up committed" />
  </div>
  <div class="row">
    <button id="save">Save trace</button>
    <button id="clear" class="secondary">Clear</button>
    <span class="count"><span id="count">0</span> events</span>
    <span id="status"></span>
  </div>

  <div id="log"></div>

<script type="module">
const RECORDED_EVENT_TYPES = ${JSON.stringify(RECORDED_EVENT_TYPES)}
const target = document.getElementById('target')
const logEl = document.getElementById('log')
const countEl = document.getElementById('count')
const statusEl = document.getElementById('status')

let events = []
let initial = snapshot()

function snapshot() {
  return {
    selectionEnd: target.selectionEnd ?? 0,
    selectionStart: target.selectionStart ?? 0,
    value: target.value
  }
}

function record(event) {
  const state = snapshot()
  const entry = { state, type: event.type }
  if (event instanceof CompositionEvent) {
    entry.data = event.data ?? ''
  } else if (event instanceof InputEvent) {
    entry.data = event.data ?? null
    entry.inputType = event.inputType
    // Safari reports undefined rather than false and the distinction is load-bearing,
    // so it is preserved instead of coerced.
    entry.isComposing = event.isComposing
  } else if (event instanceof KeyboardEvent) {
    entry.code = event.code
    entry.isComposing = event.isComposing
    entry.key = event.key
    entry.keyCode = event.keyCode
  }
  events.push(entry)
  countEl.textContent = String(events.length)
  const detail = [
    entry.key ? 'key=' + entry.key : '',
    entry.keyCode === undefined ? '' : 'keyCode=' + entry.keyCode,
    entry.inputType ? entry.inputType : '',
    entry.data === undefined ? '' : 'data=' + JSON.stringify(entry.data),
    'isComposing=' + entry.isComposing,
    'value=' + JSON.stringify(state.value),
    'sel=' + state.selectionStart + ',' + state.selectionEnd
  ].filter(Boolean).join('  ')
  logEl.textContent += event.type.padEnd(18) + detail + '\\n'
  logEl.scrollTop = logEl.scrollHeight
}

for (const type of RECORDED_EVENT_TYPES) {
  target.addEventListener(type, record, true)
}

document.getElementById('clear').addEventListener('click', () => {
  events = []
  target.value = ''
  initial = snapshot()
  logEl.textContent = ''
  countEl.textContent = '0'
  statusEl.textContent = ''
})

document.getElementById('save').addEventListener('click', async () => {
  const name = document.getElementById('name').value.trim()
  if (!name) {
    statusEl.textContent = 'Name the trace first.'
    return
  }
  if (events.length === 0) {
    statusEl.textContent = 'Nothing recorded yet.'
    return
  }
  const response = await fetch('/trace', {
    body: JSON.stringify({
      committed: document.getElementById('committed').value,
      events,
      final: snapshot(),
      initial,
      name,
      userAgent: navigator.userAgent
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST'
  })
  statusEl.textContent = response.ok ? 'Saved: ' + (await response.text()) : 'Save failed.'
})
</script>
</body>
</html>
`

function inferEnvironment(userAgent) {
  const platform = userAgent.includes('Mac')
    ? 'darwin'
    : userAgent.includes('Windows')
      ? 'win32'
      : 'linux'
  // Electron reports a Chrome token too, so WebKit and Gecko are checked first.
  const browser = userAgent.includes('Firefox')
    ? 'gecko'
    : userAgent.includes('Chrome')
      ? 'chromium'
      : 'webkit'
  return { browser, platform }
}

function toTraceFile(payload) {
  const { browser, platform } = inferEnvironment(payload.userAgent ?? '')
  return {
    committed: payload.committed ?? '',
    env: {
      browser,
      // Filled in by hand: the page cannot see which input method produced the events.
      engine: 'TODO: name the input method, e.g. macOS Pinyin - Simplified',
      platform
    },
    events: payload.events,
    final: payload.final,
    initial: payload.initial,
    name: payload.name,
    origin:
      `Recorded by config/scripts/record-ime-trace.mjs on ${platform}. ` +
      `User agent: ${payload.userAgent ?? 'unknown'}. ` +
      'TODO: describe what the human typed and the issue this belongs to.',
    provenance: 'recorded'
  }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

const server = createServer(async (request, response) => {
  if (request.method === 'GET' && (request.url === '/' || request.url === '/index.html')) {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(PAGE)
    return
  }
  if (request.method === 'POST' && request.url === '/trace') {
    try {
      const payload = JSON.parse(await readBody(request))
      const safeName = payload.name.replaceAll(/[^a-z0-9]+/gi, '-').toLowerCase()
      mkdirSync(outputDir, { recursive: true })
      const filePath = path.join(outputDir, `${safeName}.json`)
      writeFileSync(filePath, `${JSON.stringify(toTraceFile(payload), null, 2)}\n`)
      const relative = path.relative(projectDir, filePath)
      console.log(`[ime-recorder] wrote ${relative} (${payload.events.length} events)`)
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      response.end(relative)
    } catch (error) {
      console.error('[ime-recorder] failed to save trace:', error)
      response.writeHead(500)
      response.end('save failed')
    }
    return
  }
  response.writeHead(404)
  response.end()
})

server.listen(port, host, () => {
  console.log(`[ime-recorder] open http://${host}:${port}/`)
  console.log(`[ime-recorder] traces are written to ${path.relative(projectDir, outputDir)}`)
  console.log('[ime-recorder] press Ctrl+C when finished')
})
