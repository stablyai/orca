import type { PipedProcessSpec } from '@orca/process-host/process-spec'
import {
  PROVIDER_SUPERVISOR_REAP_NOW_SIGNAL,
  PROVIDER_GROUP_REAP_TIMEOUT_MS,
  PROVIDER_OUTPUT_DRAIN_TIMEOUT_MS,
  type ProviderSpawnSpec
} from './provider-process-supervisor'

export const PROVIDER_SPAWN_FAILURE_MARKER = '[orca-provider-supervisor] spawn failed: '

/** Inline supervisor source kept dependency-free for the spawned Node child. */
const POSIX_PROVIDER_SUPERVISOR_SCRIPT = `
const { spawn } = require('node:child_process')
const spec = JSON.parse(Buffer.from(process.env.ORCA_PROVIDER_SUPERVISOR_SPEC, 'base64').toString())
// The provider's own argv, after this script's '--'.
const [providerCommand, ...providerArgs] = process.argv.slice(1)
// A detached supervisor is reparented when its owner exits. The new parent may
// be PID 1 or a platform subreaper, so any other parent means no live owner.
const ownerGone = () => process.ppid !== spec.ownerPid
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
delete childEnv.ELECTRON_RUN_AS_NODE
// The owner sees only this pid's exit; this marked last stderr line says the provider never started.
const exitWithSpawnFailure = (error, thrown) => {
  const report = { thrown, code: (error && error.code) || 'UNKNOWN', message: String(error && error.message) }
  try { require('node:fs').writeSync(2, ${JSON.stringify(PROVIDER_SPAWN_FAILURE_MARKER)} + JSON.stringify(report) + '\\n') } catch {}
  process.exit(127)
}
// Orca opens the report channel only when it will keep the group's identity. Linux children
// inherit its fd, so /dev/null takes that slot and only this pid holds the channel.
const reports = typeof process.send === 'function'
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
  const disconnect = () => { try { process.disconnect() } catch {} }
  try {
    if (child.pid) process.send({ pgid: child.pid }, disconnect)
    else disconnect()
  } catch { disconnect() }
}
let timer
let ownerShutdownTimer
let settling = false
let sigtermGraceCut = false
let providerExited = false
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
  if (!signal) return process.exit(code ?? 1)
  // Re-raise with the default action; this supervisor's own handler would swallow it.
  process.removeAllListeners(signal)
  process.kill(process.pid, signal)
}
// Every stop is the same: SIGTERM the group, SIGKILL it after its grace (or once asked to reap now), and exit
// only once it is gone. Whoever stops this pid judges the provider by it, so a dead supervisor means a dead group.
const stopProviderGroup = (receivedSignal) => {
  if (settling) return
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
  process.stdin.once('end', scheduleOwnerShutdown)
  process.stdin.once('close', scheduleOwnerShutdown)
}
// A spawn that failed outright (EMFILE, ENFILE) has no pid and no pipes; its 'error' reports it.
if (child.pid) {
  process.stdin.pipe(child.stdin)
  child.stdout.pipe(process.stdout)
  child.stderr.pipe(process.stderr)
  // A dead owner's stdout pipe raises EPIPE; unhandled, it would end this pid before the group.
  for (const stream of [process.stdin, process.stdout, process.stderr, child.stdin, child.stdout, child.stderr]) {
    stream.on('error', () => {})
  }
}
// Exit can land before the provider's last output is relayed; a one-shot's answer is that output.
const drainProviderOutput = () => {
  const ended = (stream) => stream.readableEnded || stream.destroyed ? null : new Promise((resolve) => {
    stream.once('end', resolve)
    stream.once('close', resolve)
  })
  const flushed = (stream) => new Promise((resolve) => stream.write('', resolve))
  const drained = Promise.all([child.stdout, child.stderr].map(ended))
    .then(() => Promise.all([process.stdout, process.stderr].map(flushed)))
  return Promise.race([drained, new Promise((resolve) => setTimeout(resolve, ${PROVIDER_OUTPUT_DRAIN_TIMEOUT_MS}))])
}
const reapProviderExit = async (code, signal) => {
  if (settling) return
  settling = true
  clearInterval(timer)
  if (ownerShutdownTimer) clearTimeout(ownerShutdownTimer)
  if (!(await reapOwnedProviderGroup())) return process.exit(1)
  await drainProviderOutput()
  finishWithProviderOutcome(code, signal)
}
// An owner that is gone gets the close its owner would have asked for, made here on its behalf.
timer = setInterval(() => {
  if (!ownerGone()) return
  clearInterval(timer)
  process.stdin.unpipe(child.stdin)
  try { child.stdin.end() } catch {}
  // A one-shot's stdin end was its request, so only a stop is left to ask for.
  if (spec.lifetime === 'one-shot' || spec.closeRequest !== 'stdin-end') return stopProviderGroup(null)
  scheduleOwnerShutdown()
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
`

// Keep user Node startup options on the provider, outside the Electron supervisor bootstrap.
const PROVIDER_ONLY_NODE_ENV_KEYS = ['NODE_OPTIONS', 'NODE_REPL_EXTERNAL_MODULE'] as const

/** The returned child is the legacy supervisor, including its PID and signal semantics. */
export function createLegacyProviderSpawnSpec(spec: ProviderSpawnSpec): PipedProcessSpec {
  if (!spec.supervised) {
    return {
      program: spec.program,
      args: spec.args,
      env: spec.env,
      cwd: spec.cwd,
      detached: spec.detached,
      stdio: ['pipe', 'pipe', 'pipe']
    }
  }
  const supervisorEnv = { ...spec.env }
  const nodeEnv: Record<string, string> = {}
  for (const key of PROVIDER_ONLY_NODE_ENV_KEYS) {
    const value = supervisorEnv[key]
    delete supervisorEnv[key]
    if (value !== undefined) {
      nodeEnv[key] = value
    }
  }
  const supervisorSpec = Buffer.from(
    JSON.stringify({
      cwd: spec.cwd,
      ownerPid: process.pid,
      lifetime: spec.lifetime,
      closeRequest: spec.closeRequest,
      stdinEndGraceMs: spec.stdinEndGraceMs,
      sigtermGraceMs: spec.sigtermGraceMs,
      nodeEnv
    })
  ).toString('base64')
  // The native spec prefixes argv with its two graces, lifetime, close request, '--', and command.
  const providerArgs = spec.args.slice(6)
  return {
    program: process.execPath,
    args: ['-e', POSIX_PROVIDER_SUPERVISOR_SCRIPT, '--', spec.command, ...providerArgs],
    env: {
      ...supervisorEnv,
      ELECTRON_RUN_AS_NODE: '1',
      ORCA_PROVIDER_SUPERVISOR_SPEC: supervisorSpec
    },
    cwd: spec.cwd,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe', 'ipc']
  }
}

type SpawnFailureReport = { thrown: boolean; code: string; message: string }

function parseSpawnFailureReport(line: string): SpawnFailureReport | null {
  if (!line.startsWith(PROVIDER_SPAWN_FAILURE_MARKER)) {
    return null
  }
  let report: unknown
  try {
    report = JSON.parse(line.slice(PROVIDER_SPAWN_FAILURE_MARKER.length))
  } catch {
    return null
  }
  if (
    !report ||
    typeof report !== 'object' ||
    !('thrown' in report && typeof report.thrown === 'boolean') ||
    !('code' in report && typeof report.code === 'string') ||
    !('message' in report && typeof report.message === 'string')
  ) {
    return null
  }
  return { thrown: report.thrown, code: report.code, message: report.message }
}

/** Preserve whether direct spawn would throw or emit its failure. */
export type LegacyProviderSpawnFailure = { thrown: boolean; error: NodeJS.ErrnoException }

/** Only exit 127 with a final supervisor report proves provider spawn failure. */
export function legacyProviderSpawnFailure(
  code: number | null,
  stderr: string
): LegacyProviderSpawnFailure | null {
  const report =
    code === 127 ? parseSpawnFailureReport(stderr.trimEnd().split('\n').at(-1) ?? '') : null
  return report
    ? {
        thrown: report.thrown,
        error: Object.assign(new Error(report.message), { code: report.code })
      }
    : null
}

/** Render supervisor-reported failures like direct Node spawn errors. */
export function legacyProviderStderrForDisplay(stderr: string): string {
  return stderr
    .split('\n')
    .map((line) => parseSpawnFailureReport(line)?.message ?? line)
    .join('\n')
}
