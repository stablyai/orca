import { hasUnambiguousStartTime } from '../pty-descendant-termination'
import { recordSelfInitiatedTreeKill } from '../crash-reporting/self-initiated-tree-kill-log'
import { setTimeout as delay } from 'node:timers/promises'
import { readPosixProcessRow, type ProcessRowRead } from './provider-process-row-read'

// Covers the one stop the supervisor cannot make itself: its own SIGKILL leaves the provider's
// detached group running, so Orca, which outlives it, finishes the stop. POSIX only: Windows
// providers have no supervisor.

// The supervisor disconnects right after reporting, so this bounds only a wedged channel.
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
  readonly connected: boolean
  once(event: 'exit' | 'disconnect', listener: () => void): unknown
  once(event: 'message', listener: (message: unknown) => void): unknown
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
    // EPERM: the group exists but is not this user's, so it is not ours.
    return isErrnoCode(error, 'ESRCH') ? 'absent' : 'refused'
  }
  const leader = await (deps.readProcessRow ?? readPosixProcessRow)(identity.pgid)
  // Only a leader that re-proves its recorded identity names our group; a leaderless group has
  // nothing to prove it by, so its survivors are left alone. The recorded start predates its
  // read's second, so a later reuse cannot share it.
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

/**
 * Reads the group a supervisor reports on its IPC channel, proves it by the leader's parent and
 * start time, and sweeps that group once the supervisor exits. True when it is watching.
 */
export function guardSupervisedProviderGroup(
  child: GuardedChild,
  deps: ProviderGroupGuardDeps
): boolean {
  const supervisorPid = child.pid
  if (!supervisorPid || !deps.supervised) {
    return false
  }
  if (!hasReportChannel(child)) {
    // A launch adapter that rewrites stdio drops the channel; say so once instead of silently.
    if (!warnedMissingChannel) {
      warnedMissingChannel = true
      console.warn(`[provider-group-guard] ${deps.site}: supervised spawn has no report channel`)
    }
    return false
  }
  let identity: Promise<ProviderGroupIdentity | null> = Promise.resolve(null)
  // A gone supervisor parents nothing, so a re-read it would wait for can only fail; skip it.
  const proof = new AbortController()
  let channelClosed = false
  let onChannelClosed = (): void => {}
  child.once('disconnect', () => {
    channelClosed = true
    onChannelClosed()
  })
  child.once('message', (message: unknown) => {
    const pgid = reportedGroup(message)
    if (pgid !== null) {
      identity = proveReportedGroup(pgid, supervisorPid, deps, proof.signal)
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
    // Exit can be observed before the report is delivered.
    void untilChannelClosed()
      .then(() => identity)
      .then((proven) => (proven ? sweepOrphanedProviderGroup(proven, deps) : ('unproven' as const)))
      .then(deps.onSwept, () => deps.onSwept?.('refused'))
  })
  return true
}

/**
 * The leader's identity, read while this supervisor still parents it (so its pid was not reused).
 * lstart has one-second resolution, so a start in the read's own second is re-proven after that
 * second ends; otherwise a pid reused within that second would carry the same start time. A
 * supervisor gone by then no longer parents it, so nothing is armed. Accepted: on macOS a
 * supervisor SIGKILLed within its provider's first second leaves that group unswept.
 */
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
    // The boundary before ps starts, as the descendant sweep takes it.
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

function hasReportChannel(child: GuardedChild): boolean {
  try {
    return child.connected
  } catch {
    // A handle-less child can throw here; the guard must never fail the spawn it watches.
    return false
  }
}

function reportedGroup(message: unknown): number | null {
  const pgid =
    typeof message === 'object' && message !== null && 'pgid' in message ? message.pgid : null
  return typeof pgid === 'number' && Number.isSafeInteger(pgid) && pgid > 1 ? pgid : null
}

function isErrnoCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}
