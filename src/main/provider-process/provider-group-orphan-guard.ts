import type { ProviderLaunchReport } from './provider-launch-report'
import { hasUnambiguousStartTime } from '../pty-descendant-termination'
import { recordSelfInitiatedTreeKill } from '../crash-reporting/self-initiated-tree-kill-log'
import { setTimeout as delay } from 'node:timers/promises'
import { readPosixProcessRow, type ProcessRowRead } from './provider-process-row-read'

// POSIX supervisor SIGKILL can orphan its detached provider group; Orca must finish the stop.

// ACK retires the report pipe after commit; bound only an unavailable transport.
const REPORT_END_WAIT_MS = 1_000
const IDENTITY_READ_ATTEMPTS = 3
const SECOND_BOUNDARY_MARGIN_MS = 50

/** A provider group proven ours while its supervisor still parented the leader. */
export type ProviderGroupIdentity = { pgid: number; startedAt: string }

export type ProviderGroupSweepVerdict = 'absent' | 'killed' | 'refused'

export type ProviderGroupGuardDeps = {
  site: string
  /** Only a supervised POSIX spawn has a group to guard. */
  supervised: boolean
  report?: ProviderLaunchReport
  readProcessRow?: (pid: number) => Promise<ProcessRowRead>
  signalGroup?: (pgid: number, signal: NodeJS.Signals | 0) => void
  now?: () => number
  /** May settle either way once `signal` aborts; the proof checks it after. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  onProven?: (identity: ProviderGroupIdentity) => void
  /** `unproven`: no group was reported and proven ours, so nothing was swept. */
  onSwept?: (verdict: ProviderGroupSweepVerdict | 'unproven') => void
}

let warnedMissingChannel = false

type GuardedChild = {
  readonly pid?: number
  once(event: 'exit', listener: () => void): unknown
}

function defaultSignalGroup(pgid: number, signal: NodeJS.Signals | 0): void {
  process.kill(-pgid, signal)
}

/** SIGKILLs a surviving provider group, never one whose leader pid now names another process. */
export async function sweepOrphanedProviderGroup(
  identity: ProviderGroupIdentity,
  deps: ProviderGroupGuardDeps
): Promise<ProviderGroupSweepVerdict> {
  const signalGroup = deps.signalGroup ?? defaultSignalGroup
  try {
    signalGroup(identity.pgid, 0)
  } catch (error) {
    // EPERM proves existence without ownership; refuse the sweep.
    return isErrnoCode(error, 'ESRCH') ? 'absent' : 'refused'
  }
  const leader = await (deps.readProcessRow ?? readPosixProcessRow)(identity.pgid)
  // Refuse leaderless or reused groups; a start proven before its read second cannot alias later reuse.
  if (
    !leader ||
    leader === 'unverifiable' ||
    leader.pgid !== identity.pgid ||
    leader.startedAt !== identity.startedAt
  ) {
    return 'refused'
  }
  try {
    signalGroup(identity.pgid, 'SIGKILL')
  } catch (error) {
    return isErrnoCode(error, 'ESRCH') ? 'absent' : 'refused'
  }
  recordSelfInitiatedTreeKill({
    pid: identity.pgid,
    site: deps.site,
    scope: 'posix-process-group'
  })
  return 'killed'
}

/** Prove the reported group by leader parent/start time before arming its supervisor-exit sweep. */
export function guardSupervisedProviderGroup(
  child: GuardedChild,
  deps: ProviderGroupGuardDeps
): boolean {
  const supervisorPid = child.pid
  if (!supervisorPid || !deps.supervised) {
    return false
  }
  if (!deps.report) {
    // Warn once when an adapter drops the report channel instead of silently losing the guard.
    if (!warnedMissingChannel) {
      warnedMissingChannel = true
      console.warn(`[provider-group-guard] ${deps.site}: supervised spawn has no report channel`)
    }
    return false
  }
  let identity: Promise<ProviderGroupIdentity | null> = Promise.resolve(null)
  // A dead supervisor cannot parent the leader, so pending identity rereads can only fail.
  const proof = new AbortController()
  let channelClosed = false
  let onChannelClosed = (): void => {}
  void deps.report.closed.then(() => {
    channelClosed = true
    onChannelClosed()
  })
  const unsubscribe = deps.report.subscribe((record) => {
    if (record.kind === 'spawned') {
      identity = proveReportedGroup(record.pgid, supervisorPid, deps, proof.signal)
      void identity.then((proven) => proven && deps.onProven?.(proven))
    }
  })
  const untilChannelClosed = (): Promise<void> =>
    channelClosed
      ? Promise.resolve()
      : new Promise((resolve) => {
          const timer = setTimeout(resolve, REPORT_END_WAIT_MS)
          timer.unref?.()
          onChannelClosed = () => {
            clearTimeout(timer)
            resolve()
          }
        })
  child.once('exit', () => {
    proof.abort()
    unsubscribe()
    // Exit can be observed before the report is delivered.
    void untilChannelClosed()
      .then(() => identity)
      .then((proven) => (proven ? sweepOrphanedProviderGroup(proven, deps) : ('unproven' as const)))
      .then(deps.onSwept, () => deps.onSwept?.('refused'))
  })
  return true
}

/** Reprove second-resolution starts after the second ends to reject same-second PID reuse.
 * Supervisor death before proof leaves the group unswept, including macOS starts killed within one second. */
async function proveReportedGroup(
  pgid: number,
  supervisorPid: number,
  deps: ProviderGroupGuardDeps,
  signal: AbortSignal
): Promise<ProviderGroupIdentity | null> {
  const readRow = deps.readProcessRow ?? readPosixProcessRow
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? sleepUnref
  for (let attempt = 0; attempt < IDENTITY_READ_ATTEMPTS; attempt += 1) {
    // Capture the boundary before ps starts, matching the descendant sweep.
    const capturedAtMs = now()
    const row = await readRow(pgid)
    if (!row || row === 'unverifiable' || row.ppid !== supervisorPid || row.pgid !== pgid) {
      return null
    }
    if (
      row.startResolution === 'clock-tick' ||
      hasUnambiguousStartTime(row.startedAt, capturedAtMs)
    ) {
      return { pgid, startedAt: row.startedAt }
    }
    await sleep(1_000 - (now() % 1_000) + SECOND_BOUNDARY_MARGIN_MS, signal).catch(() => {})
    if (signal.aborted) {
      return null
    }
  }
  return null
}

function sleepUnref(ms: number, signal: AbortSignal): Promise<void> {
  return delay(ms, undefined, { signal, ref: false })
}

function isErrnoCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}
