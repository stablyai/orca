import type { CodexAppServerLaunch } from './codex-app-server-connection'

/** Time the provider gets to exit on its own after its stdin ends, before SIGTERM. */
export const PROVIDER_STDIN_END_GRACE_MS = 1_000
/** Time the provider group gets to flush and exit after SIGTERM, before SIGKILL. */
export const PROVIDER_SIGTERM_GRACE_MS = 3_000
/**
 * How long the supervisor waits for a SIGKILLed group to disappear. A killed process never runs
 * again, so this only covers the kernel finishing the kill; waiting forever could hang close or
 * recovery on a process stuck in the kernel, such as one blocked on a hung network drive.
 */
export const PROVIDER_GROUP_REAP_TIMEOUT_MS = 1_500
/**
 * Longest a supervisor can take to stop once asked (stdin end, grace, SIGTERM, grace, SIGKILL,
 * reap); a SIGKILL sooner can orphan its group. The graces are also the largest a spec may carry.
 */
export const PROVIDER_SUPERVISOR_MAX_STOP_MS =
  PROVIDER_STDIN_END_GRACE_MS + PROVIDER_SIGTERM_GRACE_MS + PROVIDER_GROUP_REAP_TIMEOUT_MS

/** Inline supervisor source kept dependency-free for the spawned Node child. */
export const POSIX_PROVIDER_SUPERVISOR_SCRIPT = `
const { spawn } = require('node:child_process')
const spec = JSON.parse(Buffer.from(process.env.ORCA_PROVIDER_SUPERVISOR_SPEC, 'base64').toString())
// A detached supervisor is reparented when its owner exits. The new parent may
// be PID 1 or a platform subreaper, so any other parent means no live owner.
const ownerGone = () => process.ppid !== spec.ownerPid
// Registered before the spawn, so a stop that lands while the provider starts still reaps it.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => stopProviderGroup(signal))
// Orca can die before this runs; spawning then would start a provider nothing watches.
if (ownerGone()) process.exit(1)
const childEnv = { ...process.env }
delete childEnv.ORCA_PROVIDER_SUPERVISOR_SPEC
delete childEnv.ELECTRON_RUN_AS_NODE
const child = spawn(spec.command, spec.args, {
  cwd: spec.cwd,
  env: childEnv,
  stdio: ['pipe', 'pipe', 'pipe'],
  detached: true
})
let timer
let ownerShutdownTimer
let settling = false
const providerGroupExists = () => {
  if (!child.pid) return false
  try {
    process.kill(-child.pid, 0)
    return true
  } catch (error) {
    return Boolean(error && error.code !== 'ESRCH')
  }
}
const waitForProviderGroupExit = async (timeoutMs) => {
  const deadline = Date.now() + timeoutMs
  while (providerGroupExists()) {
    if (Date.now() >= deadline) return false
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
// Every stop is the same: SIGTERM the group, SIGKILL it after its grace, and exit only once it is
// gone. Whoever stops this pid judges the provider by it, so a dead supervisor means a dead group.
const stopProviderGroup = (receivedSignal) => {
  if (settling) return
  settling = true
  clearInterval(timer)
  if (ownerShutdownTimer) clearTimeout(ownerShutdownTimer)
  try { process.kill(-child.pid, 'SIGTERM') } catch {}
  void waitForProviderGroupExit(spec.sigtermGraceMs)
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
process.stdin.once('end', scheduleOwnerShutdown)
process.stdin.once('close', scheduleOwnerShutdown)
process.stdin.pipe(child.stdin)
child.stdout.pipe(process.stdout)
child.stderr.pipe(process.stderr)
// A dead owner's stdout pipe raises EPIPE; unhandled, it would end this pid before the group.
for (const stream of [process.stdin, process.stdout, process.stderr, child.stdin, child.stdout, child.stderr]) {
  stream.on('error', () => {})
}
const reapProviderExit = async (code, signal) => {
  if (settling) return
  settling = true
  clearInterval(timer)
  if (ownerShutdownTimer) clearTimeout(ownerShutdownTimer)
  if (!(await reapOwnedProviderGroup())) return process.exit(1)
  finishWithProviderOutcome(code, signal)
}
timer = setInterval(() => {
  if (ownerGone()) stopProviderGroup(null)
}, 100)
timer.unref()
child.once('error', (error) => {
  clearInterval(timer)
  // The owner sees only this pid's exit; stderr is where a missing provider binary can say so.
  process.stderr.write(String(error && error.message) + '\\n', () => process.exit(127))
})
child.once('exit', (code, signal) => {
  void reapProviderExit(code, signal)
})
`

export type ProviderSupervisorOptions = {
  cwd?: string
  /** The process the supervisor serves; it must be the supervisor's parent. */
  ownerPid?: number
  stdinEndGraceMs?: number
  sigtermGraceMs?: number
}

// A longer grace than the max stop allows would let recovery or close SIGKILL mid-stop.
function assertGraceWithin(name: string, graceMs: number, maxMs: number): void {
  if (!(graceMs >= 0 && graceMs <= maxMs)) {
    throw new RangeError(`Provider supervisor ${name} grace ${graceMs} ms is outside 0-${maxMs} ms`)
  }
}

export function supervisedPosixLaunch(
  launch: CodexAppServerLaunch,
  childEnv: NodeJS.ProcessEnv,
  {
    cwd = launch.cwd ?? process.cwd(),
    ownerPid = process.pid,
    stdinEndGraceMs = PROVIDER_STDIN_END_GRACE_MS,
    sigtermGraceMs = PROVIDER_SIGTERM_GRACE_MS
  }: ProviderSupervisorOptions = {}
): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  assertGraceWithin('stdin-end', stdinEndGraceMs, PROVIDER_STDIN_END_GRACE_MS)
  assertGraceWithin('SIGTERM', sigtermGraceMs, PROVIDER_SIGTERM_GRACE_MS)
  const supervisorSpec = Buffer.from(
    JSON.stringify({
      command: launch.command,
      args: launch.args,
      cwd,
      ownerPid,
      stdinEndGraceMs,
      sigtermGraceMs
    })
  ).toString('base64')
  return {
    command: process.execPath,
    args: ['-e', POSIX_PROVIDER_SUPERVISOR_SCRIPT],
    // Electron's executable needs Node mode for the inline supervisor. The
    // marker is removed above so providers never inherit Electron semantics.
    env: {
      ...childEnv,
      ELECTRON_RUN_AS_NODE: '1',
      ORCA_PROVIDER_SUPERVISOR_SPEC: supervisorSpec
    }
  }
}

export function createProviderSpawnSpec(
  launch: CodexAppServerLaunch,
  childEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): {
  program: string
  args: string[]
  env: NodeJS.ProcessEnv
  cwd: string
  detached: boolean
  /** The child is the supervisor, whose SIGTERM stops the provider and then itself. */
  supervised: boolean
} {
  const supervisor = platform === 'win32' ? null : supervisedPosixLaunch(launch, childEnv)
  return {
    program: supervisor?.command ?? launch.command,
    args: supervisor?.args ?? launch.args,
    env: supervisor?.env ?? childEnv,
    cwd: launch.cwd ?? process.cwd(),
    detached: platform !== 'win32',
    supervised: supervisor !== null
  }
}
