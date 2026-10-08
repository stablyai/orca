import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { captureLiveInputLag } from './capture-live-input-lag.mjs'
import { connectOrcaMainInspector } from './orca-main-inspector-connection.mjs'

// Diagnostic-only adapter: Electron CDP on the verified existing renderer; no window actions.
const expectedPid = Number(process.argv[2])
const rendererId = Number(process.argv[3])
if (!expectedPid || !rendererId) {
  throw new Error('Usage: node capture-running-orca-lag.mjs MAIN_PID WEB_CONTENTS_ID')
}
const connection = await connectOrcaMainInspector(expectedPid, rendererId)
const { send, evaluateMain, evaluateRenderer, contents } = connection
let attached = false
let echoStarted = false
let mainProfiling = false
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
        send: connection.cdp,
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
  connection.close()
}
