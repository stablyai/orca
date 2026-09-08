import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { captureLiveInputLag } from './capture-live-input-lag.mjs'

// Diagnostic-only adapter: Electron CDP on the verified existing renderer; no window actions.
const expectedPid = Number(process.argv[2])
const rendererId = Number(process.argv[3])
if (!expectedPid || !rendererId) {
  throw new Error('Usage: node capture-running-orca-lag.mjs MAIN_PID WEB_CONTENTS_ID')
}
const [target] = await (await fetch('http://127.0.0.1:9229/json/list')).json()
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.onopen = resolve
  socket.onerror = reject
})
let nextId = 0
const pending = new Map()
socket.onmessage = (event) => {
  const message = JSON.parse(event.data)
  const callback = pending.get(message.id)
  if (callback) {
    pending.delete(message.id)
    clearTimeout(callback.timer)
    if (message.error) {
      callback.reject(new Error(JSON.stringify(message.error)))
    } else {
      callback.resolve(message.result)
    }
  }
}
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`Timed out: ${method}`))
    }, 15_000)
    pending.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluateMain(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  })
  if (result.exceptionDetails) {
    throw new Error(result.result.description ?? JSON.stringify(result.exceptionDetails))
  }
  return result.result.value
}
const contents = `process.getBuiltinModule('module').createRequire(process.execPath)('electron').webContents.fromId(${rendererId})`
let attached = false
let echoStarted = false
let mainProfiling = false
const evaluateRenderer = (expression) =>
  evaluateMain(`${contents}.executeJavaScript(${JSON.stringify(expression)})`)
try {
  const identity = await evaluateMain(
    `({pid:process.pid,type:${contents}.getType(),rendererPid:${contents}.getOSProcessId(),attached:${contents}.debugger.isAttached()})`
  )
  if (identity.pid !== expectedPid || identity.type !== 'window' || identity.attached) {
    throw new Error(`Unexpected or already-debugged target: ${JSON.stringify(identity)}`)
  }
  const before = await evaluateRenderer('window.__orcaTypingDiagnostic.report()')
  if (before.sampling.running) {
    throw new Error('An existing typing diagnostic is running')
  }
  await evaluateMain(`${contents}.debugger.attach('1.3')`)
  attached = true
  const page = {
    evaluate: (fn, arg) => evaluateRenderer(`(${fn.toString()})(${JSON.stringify(arg) ?? ''})`),
    context: () => ({
      newCDPSession: async () => ({
        send: (method, params = {}) =>
          evaluateMain(
            `${contents}.debugger.sendCommand(${JSON.stringify(method)},${JSON.stringify(params)})`
          ),
        detach: async () => {}
      })
    })
  }
  await evaluateRenderer('window.__orcaTypingDiagnostic.start()')
  echoStarted = true
  await send('Profiler.enable')
  await send('Profiler.start')
  mainProfiling = true
  console.log(
    JSON.stringify({ captureStarted: new Date().toISOString(), identity, census: before.census })
  )
  const result = await captureLiveInputLag(page, 30_000)
  const { profile } = await send('Profiler.stop')
  mainProfiling = false
  await evaluateRenderer('window.__orcaTypingDiagnostic.stop()')
  echoStarted = false
  const echo = await evaluateRenderer('window.__orcaTypingDiagnostic.report()')
  await writeFile(join(result.directory, 'main.cpuprofile'), JSON.stringify(profile), {
    mode: 0o600
  })
  await writeFile(join(result.directory, 'terminal-echo.json'), JSON.stringify(echo, null, 2), {
    mode: 0o600
  })
  console.log(JSON.stringify({ ...result, echo }, null, 2))
} finally {
  if (echoStarted) {
    await evaluateRenderer('window.__orcaTypingDiagnostic.stop()').catch(() => {})
  }
  if (mainProfiling) {
    await send('Profiler.stop').catch(() => {})
  }
  await send('Profiler.disable').catch(() => {})
  if (attached) {
    await evaluateMain(`${contents}.debugger.detach()`).catch(() => {})
  }
  socket.close()
}
