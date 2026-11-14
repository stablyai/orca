import { PROVIDER_SPAWN_FAILURE_MARKER } from './provider-spawn-failure-report'

/** Time the provider gets to exit on its own after its stdin ends, before SIGTERM. */
export const PROVIDER_STDIN_END_GRACE_MS = 1_000
/** Time the provider group gets to flush and exit after SIGTERM, before SIGKILL. */
export const PROVIDER_SIGTERM_GRACE_MS = 3_000
/** A stop the user waits on (context clear) asks the supervisor to reap its group after this;
 * Claude itself usually exits within it, so only a straggler in its group gets killed. */
export const PROVIDER_BRIEF_SIGTERM_GRACE_MS = 1_000
/** Asks a stopping supervisor to reap its group now; a repeated SIGTERM stays a plain stop. */
export const PROVIDER_SUPERVISOR_REAP_NOW_SIGNAL = 'SIGUSR2'
/** Bound kernel kill completion; a process stuck on a hung drive must not hang close/recovery forever. */
export const PROVIDER_GROUP_REAP_TIMEOUT_MS = 1_500
/** Direct stdio drain budget; hosted output instead remains bound to its live owner. */
export const PROVIDER_OUTPUT_DRAIN_TIMEOUT_MS = 1_000
/** Wrapper stop budget; killing it before both graces and reap finish can orphan the group. */
export const PROVIDER_SUPERVISOR_MAX_STOP_MS =
  PROVIDER_STDIN_END_GRACE_MS + PROVIDER_SIGTERM_GRACE_MS + PROVIDER_GROUP_REAP_TIMEOUT_MS

/** Inline supervisor source kept dependency-free for the spawned Node child. */
export const POSIX_PROVIDER_SUPERVISOR_SCRIPT = `
const { spawn } = require('node:child_process')
void (async () => {
const spec = JSON.parse(Buffer.from(process.env.ORCA_PROVIDER_SUPERVISOR_SPEC, 'base64').toString())
// The provider's own argv, after this script's '--'.
const [providerCommand, ...providerArgs] = process.argv.slice(1)
// A detached supervisor is reparented when its owner exits. The new parent may
// be PID 1 or a platform subreaper, so any other parent means no live owner.
const ownerGone = () => process.ppid !== spec.ownerPid
const bridge = process.env.ORCA_PROVIDER_OWNER_CHANNEL
  ? await connectOwnerChannels(JSON.parse(process.env.ORCA_PROVIDER_OWNER_CHANNEL))
  : null
const input = bridge ? bridge.duplex : process.stdin
const output = bridge ? bridge.duplex : process.stdout
const errorOutput = bridge ? bridge.stderr : process.stderr
const report = bridge ? (value) => bridge.control.write(JSON.stringify(value) + '\\n') : null
// Registered before the spawn, so a stop that lands while the provider starts still reaps it.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => stopProviderGroup(signal))
process.on(${JSON.stringify(PROVIDER_SUPERVISOR_REAP_NOW_SIGNAL)}, () => {
  sigtermGraceCut = true
  stopProviderGroup('SIGTERM')
})
// Orca can die before this runs; spawning then would start a provider nothing watches.
if (ownerGone()) process.exit(1)
const childEnv = { ...process.env, ...spec.nodeEnv }
delete childEnv.ORCA_PROVIDER_SUPERVISOR_SPEC
delete childEnv.ORCA_PROVIDER_OWNER_CHANNEL
delete childEnv.ELECTRON_RUN_AS_NODE
// The owner sees only this pid's exit; this marked last stderr line says the provider never started.
const exitWithSpawnFailure = (error, thrown) => {
  const report = { thrown, code: (error && error.code) || 'UNKNOWN', message: String(error && error.message) }
  const line = ${JSON.stringify(PROVIDER_SPAWN_FAILURE_MARKER)} + JSON.stringify(report) + '\\n'
  if (bridge) return errorOutput.write(line, () => process.exit(127))
  try { require('node:fs').writeSync(2, line) } catch {}
  process.exit(127)
}
// Orca opens the report channel only when it will keep the group's identity. Linux children
// inherit its fd, so /dev/null takes that slot and only this pid holds the channel.
const reports = bridge || typeof process.send === 'function'
const reportShield = reports ? require('node:fs').openSync('/dev/null', 'r') : null
let child
try {
  child = spawn(providerCommand, providerArgs, {
    cwd: spec.cwd,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe', ...(reportShield === null ? [] : [reportShield])],
    detached: true
  })
} catch (error) {
  // Node throws most spawn failures (ENOEXEC, ENOTDIR, ...) rather than emitting them.
  exitWithSpawnFailure(error, true)
}
// With the group's identity in Orca, a SIGKILL of this pid cannot orphan the group.
if (reports) {
  try { require('node:fs').closeSync(reportShield) } catch {}
  const disconnect = () => { try { if (bridge) report({ reportEnd: true }); else process.disconnect() } catch {} }
  try {
    if (child.pid) { if (bridge) { report({ pgid: child.pid }); disconnect() } else process.send({ pgid: child.pid }, disconnect) }
    else disconnect()
  } catch { disconnect() }
}
let timer
let ownerShutdownTimer
let settling = false
let sigtermGraceCut = false
let providerExited = false
let abortOutputDrain
const providerGroupExists = () => {
  if (!child.pid) return false
  try {
    process.kill(-child.pid, 0)
    return true
  } catch (error) {
    return Boolean(error && error.code !== 'ESRCH')
  }
}
const waitForProviderGroupExit = async (timeoutMs, stopWaiting = () => false) => {
  const deadline = Date.now() + timeoutMs
  while (providerGroupExists()) {
    if (Date.now() >= deadline || stopWaiting()) return false
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return true
}
const reapOwnedProviderGroup = async () => {
  if (!child.pid) return false
  try { process.kill(-child.pid, 'SIGKILL') } catch (error) {
    if (error && error.code !== 'ESRCH') return false
  }
  return waitForProviderGroupExit(${PROVIDER_GROUP_REAP_TIMEOUT_MS})
}
const finishWithProviderOutcome = (code, signal) => {
  clearInterval(timer)
  if (ownerShutdownTimer) clearTimeout(ownerShutdownTimer)
  if (!signal) return process.exit(code ?? 1)
  // Re-raise with the default action; this supervisor's own handler would swallow it.
  process.removeAllListeners(signal)
  process.kill(process.pid, signal)
}
// Every stop is the same: SIGTERM the group, SIGKILL it after its grace (or once asked to reap now), and exit
// only once it is gone. Whoever stops this pid judges the provider by it, so a dead supervisor means a dead group.
const stopProviderGroup = (receivedSignal) => {
  if (settling) {
    if (abortOutputDrain) abortOutputDrain(receivedSignal)
    return
  }
  settling = true
  clearInterval(timer)
  if (ownerShutdownTimer) clearTimeout(ownerShutdownTimer)
  try { process.kill(-child.pid, 'SIGTERM') } catch {}
  // A one-shot's helpers die with it once it has exited; a session's keep the grace to clean up.
  const graceOver = () => sigtermGraceCut || (spec.lifetime === 'one-shot' && providerExited)
  void waitForProviderGroupExit(spec.sigtermGraceMs, graceOver)
    .then((exited) => exited || reapOwnedProviderGroup())
    .then((reaped) => {
      if (!reaped) return process.exit(1)
      finishWithProviderOutcome(137, receivedSignal)
    })
}
const scheduleOwnerShutdown = () => {
  if (settling || ownerShutdownTimer) return
  // A normal close ends the provider's stdin first; allow it to flush and
  // exit before forcing the group, while still bounding an orphaned child.
  ownerShutdownTimer = setTimeout(() => stopProviderGroup(null), spec.stdinEndGraceMs)
  ownerShutdownTimer.unref()
}
// A one-shot's stdin end is the end of its request, not a stop; only its owner's death stops it.
if (spec.lifetime !== 'one-shot') {
  input.once('end', scheduleOwnerShutdown)
  input.once('close', scheduleOwnerShutdown)
}
// A spawn that failed outright (EMFILE, ENFILE) has no pid and no pipes; its 'error' reports it.
if (child.pid) {
  input.pipe(child.stdin)
  child.stdout.pipe(output)
  child.stderr.pipe(errorOutput)
  // A dead owner's stdout pipe raises EPIPE; unhandled, it would end this pid before the group.
  for (const stream of [input, output, errorOutput, child.stdin, child.stdout, child.stderr]) {
    stream.on('error', () => {})
  }
}
// Exit can land before the provider's last output is relayed; a one-shot's answer is that output.
const drainProviderOutput = (signal) => {
  if (bridge) {
    const { finished } = require('node:stream/promises')
    return Promise.all([
      ...[child.stdout, child.stderr].map(stream => finished(stream, { writable: false, cleanup: true, signal })),
      ...[output, errorOutput].map(stream => finished(stream, { readable: false, cleanup: true, signal }))
    ])
  }
  const ended = (stream) => stream.readableEnded || stream.destroyed ? null : new Promise((resolve) => {
    stream.once('end', resolve)
    stream.once('close', resolve)
  })
  const flushed = (stream) => new Promise((resolve) => stream.write('', resolve))
  const drained = Promise.all([child.stdout, child.stderr].map(ended))
    .then(() => Promise.all([output, errorOutput].map(flushed)))
  return Promise.race([drained, new Promise((resolve) => setTimeout(resolve, ${PROVIDER_OUTPUT_DRAIN_TIMEOUT_MS}))])
}
const reapProviderExit = async (code, signal) => {
  if (settling) return
  settling = true
  const controller = bridge ? new AbortController() : null
  if (controller) abortOutputDrain = (signal) => controller.abort(signal)
  else clearInterval(timer)
  if (ownerShutdownTimer) clearTimeout(ownerShutdownTimer)
  if (!(await reapOwnedProviderGroup())) return process.exit(1)
  try {
    if (bridge && (ownerGone() || bridge.control.readableEnded || bridge.control.destroyed)) {
      controller.abort(null)
    }
    await drainProviderOutput(controller?.signal)
  } catch {
    controller?.abort()
    return finishWithProviderOutcome(1, typeof controller?.signal.reason === 'string' ? controller.signal.reason : null)
  }
  finishWithProviderOutcome(code, signal)
}
const closeForOwnerDeath = () => {
  if (settling && abortOutputDrain) return abortOutputDrain(null)
  input.unpipe(child.stdin)
  try { child.stdin.end() } catch {}
  if (spec.lifetime === 'one-shot' || spec.closeRequest !== 'stdin-end') return stopProviderGroup(null)
  scheduleOwnerShutdown()
}
if (bridge) {
  bridge.control.once('end', closeForOwnerDeath)
  bridge.control.once('close', closeForOwnerDeath)
  for (const stream of [bridge.duplex, bridge.stderr]) stream.once('error', closeForOwnerDeath)
}
// Parent death covers a crashed host even while the GUI's owner socket remains open.
timer = setInterval(() => {
  if (!ownerGone()) return
  clearInterval(timer)
  closeForOwnerDeath()
}, 100)
timer.unref()
child.once('error', (error) => {
  clearInterval(timer)
  exitWithSpawnFailure(error, false)
})
child.once('exit', (code, signal) => {
  providerExited = true
  void reapProviderExit(code, signal)
})
})().catch(() => process.exit(1))

async function connectOwnerChannels({ path, nonce }) {
  const { connect } = require('node:net')
  const sockets = {}
  let deadline
  try {
    await Promise.race([
      Promise.all(['duplex', 'stderr', 'control'].map((role) => new Promise((resolve, reject) => {
        const socket = connect({ path, allowHalfOpen: true })
        sockets[role] = socket
        socket.once('error', reject)
        socket.once('connect', () => {
          socket.write(JSON.stringify({ nonce, role, pid: process.pid }) + '\\n')
          resolve()
        })
      }))).then(() => new Promise((resolve, reject) => {
        let line = ''
        const control = sockets.control
        control.once('end', () => reject(new Error('Owner gone')))
        control.once('close', () => reject(new Error('Owner gone')))
        const read = (chunk) => {
          line += chunk.toString('utf8')
          if (line.length > 128) return reject(new Error('Invalid owner response'))
          const end = line.indexOf('\\n')
          if (end < 0) return
          control.off('data', read)
          if (line !== '{"go":true}\\n') return reject(new Error('Invalid owner response'))
          resolve()
        }
        control.on('data', read)
      })),
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Owner timeout')), 10000) })
    ])
    return sockets
  } catch (error) {
    for (const socket of Object.values(sockets)) socket.destroy()
    throw error
  } finally {
    clearTimeout(deadline)
  }
}
`
