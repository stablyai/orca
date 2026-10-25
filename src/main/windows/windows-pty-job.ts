import type { IPty } from 'node-pty'
import { createRequire } from 'node:module'
import { recordSelfInitiatedTreeKill } from '../crash-reporting/self-initiated-tree-kill-log'

/** Kernel job handles own ConPTY descendants across PID reuse/reparenting (#9045/#10475/#10087). Per-PTY jobs make explicit teardown exact without kill-on-close, preserving background children on clean shell exit. */

const requireFromMain = createRequire(__filename)

type ConptyNative = {
  terminateJob: (id: number, shellPid: number) => boolean
  listJobProcessIds: (id: number, shellPid: number) => number[] | null
  assignCurrentProcessToJob: () => boolean
  /** Absent on builds that predate the terminal process ceiling. */
  setActiveProcessLimit?: (limit: number) => boolean
}

type SelfOwnedPty = IPty & {
  jobRootProcessIsWrapper?: true
  shellProcessId?: number
  terminateOwnedTree?: () => JobTerminationOutcome
  listOwnedProcessIds?: () => readonly number[] | null
}

/** The gate's pid never proves that its user shell remains alive. */
export function ptyShellProcessId(proc: IPty): number | undefined {
  const owned: SelfOwnedPty = proc
  return owned.jobRootProcessIsWrapper ? owned.shellProcessId : proc.pid
}

let cachedNative: ConptyNative | null | undefined
let nativeLoader: () => ConptyNative | null = loadConptyNative

function loadConptyNative(): ConptyNative | null {
  if (cachedNative !== undefined) {
    return cachedNative
  }
  if (process.platform !== 'win32') {
    cachedNative = null
    return cachedNative
  }
  try {
    const { loadNativeModule } = requireFromMain('node-pty/lib/utils') as {
      loadNativeModule: (name: string) => { module: unknown }
    }
    const native = loadNativeModule('conpty').module as Partial<ConptyNative>
    // Feature-detect patched symbols; unpatched node-pty must degrade without throwing.
    cachedNative =
      typeof native?.terminateJob === 'function' && typeof native?.listJobProcessIds === 'function'
        ? (native as ConptyNative)
        : null
  } catch {
    cachedNative = null
  }
  return cachedNative
}

/** Pair private PTY ID with shell PID defensively: winpty's separate counter can collide with a live ConPTY ID; native code rejects mismatches. */
function ptyJobTarget(proc: IPty): { id: number; shellPid: number } | null {
  const id = (proc as unknown as { _pty?: unknown })._pty
  const shellPid = proc.pid
  if (!Number.isInteger(id) || !Number.isInteger(shellPid) || (shellPid as number) <= 0) {
    return null
  }
  return { id: id as number, shellPid: shellPid as number }
}

export type JobTerminationOutcome = 'terminated' | 'unavailable'

/** Unavailable job ownership is never successful termination; callers must use their fallback. */
export function terminatePtyJob(proc: IPty): JobTerminationOutcome {
  const owned: SelfOwnedPty = proc
  if (typeof owned.terminateOwnedTree === 'function') {
    let outcome: JobTerminationOutcome
    try {
      outcome = owned.terminateOwnedTree()
    } catch {
      return 'unavailable'
    }
    if (outcome === 'terminated') {
      recordSelfInitiatedTreeKill({
        pid: proc.pid,
        site: 'windows-pty-job-teardown',
        scope: 'win-pty-job'
      })
    }
    return outcome
  }
  const target = ptyJobTarget(proc)
  const native = nativeLoader()
  if (!target || !native) {
    return 'unavailable'
  }
  let terminated: boolean
  try {
    terminated = native.terminateJob(target.id, target.shellPid)
  } catch {
    return 'unavailable'
  }
  if (!terminated) {
    return 'unavailable'
  }
  // Keep diagnostics outside the native catch: a breadcrumb throw must not downgrade termination and escalate taskkill.
  recordSelfInitiatedTreeKill({
    pid: target.shellPid,
    site: 'windows-pty-job-teardown',
    scope: 'win-pty-job'
  })
  return 'terminated'
}

/** Null means unverifiable, never dead: shell exit closes the job even while its handle record survives until kill(). Tracked jobs include detached descendants; see docs/reference/ssh-execution-boundary.md. */
export function listPtyJobProcessIds(proc: IPty): readonly number[] | null {
  const owned: SelfOwnedPty = proc
  if (typeof owned.listOwnedProcessIds === 'function') {
    try {
      return owned.listOwnedProcessIds()
    } catch {
      return null
    }
  }
  const target = ptyJobTarget(proc)
  const native = nativeLoader()
  if (!target || !native) {
    return null
  }
  try {
    return native.listJobProcessIds(target.id, target.shellPid)
  } catch {
    return null
  }
}

/** Assign the terminal daemon to a separate kill-on-close job before its first PTY; existing children cannot join retroactively. Do this in the spawn path after readiness to avoid loading ConPTY during startup. Never assign app-main: sessions must survive its crashes. Per-PTY jobs stay non-kill-on-close to preserve clean-exit background children. Refused nesting returns false (#9195/#10415). */
let hostJobAssigned: boolean | null = null

export function assignHostProcessToKillOnCloseJob(): boolean {
  if (hostJobAssigned !== null) {
    return hostJobAssigned
  }
  hostJobAssigned = assignHostProcessOnce()
  return hostJobAssigned
}

function assignHostProcessOnce(): boolean {
  const native = nativeLoader()
  if (!native) {
    return false
  }
  try {
    return native.assignCurrentProcessToJob()
  } catch {
    return false
  }
}

/** An ActiveProcessLimit for every later ConPTY's job; false when this build cannot set one. */
export function setPtyActiveProcessLimit(limit: number): boolean {
  const native = nativeLoader()
  if (typeof native?.setActiveProcessLimit !== 'function') {
    return false
  }
  try {
    return native.setActiveProcessLimit(limit)
  } catch {
    return false
  }
}

/** Whether this build can own PTY trees with job objects at all. */
export function isPtyJobOwnershipAvailable(): boolean {
  return nativeLoader() !== null
}

/** Test-only: substitute the native module (it is resolved via createRequire). */
export function __setConptyJobNativeForTests(loader?: () => ConptyNative | null): void {
  nativeLoader = loader ?? loadConptyNative
  cachedNative = undefined
  hostJobAssigned = null
}

type UnreadyWindowsPty = IPty & { _agent?: { kill?: () => void } }

// Bypass node-pty's output-deferred kill to release silent ConPTY hosts, input pipes and output workers immediately.
export function killConptyNow(proc: IPty): void {
  const pane: UnreadyWindowsPty = proc
  try {
    pane._agent?.kill?.()
  } catch {
    // Best effort; the host job still reaps the console host with the daemon.
  }
}
