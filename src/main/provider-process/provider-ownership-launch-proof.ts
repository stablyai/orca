import { setTimeout as delay } from 'node:timers/promises'
import {
  providerDiagnostic,
  withProviderDiagnostic
} from '../../shared/agent-session/failures/agent-session-failure'
import { providerOwnerPidAbsent, type ProviderProcessRow } from './provider-process-row-read'
import {
  readProviderProcessIdentity,
  type ProviderProcessIdentityRead
} from './provider-group-orphan-guard'

// One worst-case proof (two 2 s reads around a 1 s second-boundary wait) still fits the 15 s bootstrap deadline.
const OWNERSHIP_PROOF_WINDOW_MS = 9_000
const OWNERSHIP_PROOF_MAX_BACKOFF_MS = 1_000

let ownerIdentity: Promise<ProviderProcessIdentityRead> | undefined

export type ProviderOwnershipLaunchRows = {
  owner: ProviderProcessRow
  leader: ProviderProcessRow
  watcher: ProviderProcessRow
}

/** Proves Orca, the launch leader and its watcher before the CLI runs; the error names each failed check. */
export async function proveProviderOwnershipBeforeLaunch(
  leaderPid: number,
  watcherPid: number,
  parentPid: number
): Promise<ProviderOwnershipLaunchRows> {
  const deadline = performance.now() + OWNERSHIP_PROOF_WINDOW_MS
  ownerIdentity ??= proveOwnershipRow(process.pid, deadline)
  // Orphans reparent to an existing reaper, so the leader's ppid alone proves our parent is live.
  const [owner, leader, watcher] = await Promise.all([
    ownerIdentity,
    proveOwnershipRow(leaderPid, deadline),
    proveOwnershipRow(watcherPid, deadline)
  ])
  if (typeof owner !== 'object') {
    ownerIdentity = undefined
  }
  const failed = [
    ...rowFailure('owner', owner),
    ...rowFailure('leader', leader),
    ...rowFailure('watcher', watcher),
    ...(typeof leader === 'object'
      ? [
          ...mismatch('leader ppid', leader.ppid, parentPid),
          ...mismatch('leader pgid', leader.pgid, leaderPid)
        ]
      : []),
    ...(typeof watcher === 'object'
      ? [
          ...mismatch('watcher ppid', watcher.ppid, leaderPid),
          ...mismatch('watcher pgid', watcher.pgid, watcherPid)
        ]
      : []),
    ...(watcherPid === leaderPid ? ['watcher is the leader'] : [])
  ]
  if (
    typeof owner !== 'object' ||
    typeof leader !== 'object' ||
    typeof watcher !== 'object' ||
    failed.length > 0
  ) {
    const message = `Cannot establish provider process ownership before launch: ${failed.join('; ')}`
    throw withProviderDiagnostic(new Error(message), providerDiagnostic(message, 'log'))
  }
  return { owner, leader, watcher }
}

/** A failed or timed-out read proves nothing, so retry it; only a definite answer ends the proof early. */
async function proveOwnershipRow(
  pid: number,
  deadline: number
): Promise<ProviderProcessIdentityRead> {
  for (let attempt = 0; ; attempt++) {
    const read = await readProviderProcessIdentity(pid)
    // Older native readers can omit a live pid; only ESRCH proves it gone.
    if (read !== 'unverifiable' && (read !== 'absent' || providerOwnerPidAbsent(pid))) {
      return read
    }
    // Jitter keeps a burst of concurrent launches from rereading in lockstep.
    const backoff =
      Math.min(OWNERSHIP_PROOF_MAX_BACKOFF_MS, 100 * 2 ** attempt) * (0.5 + Math.random() / 2)
    if (performance.now() + backoff >= deadline) {
      return 'unverifiable'
    }
    await delay(backoff)
  }
}

function rowFailure(role: string, read: ProviderProcessIdentityRead): string[] {
  if (typeof read === 'object') {
    return []
  }
  const outcome =
    read === 'unverifiable'
      ? 'read unverifiable'
      : read === 'absent'
        ? 'exited'
        : 'identity changed'
  return [`${role} ${outcome}`]
}

function mismatch(check: string, actual: number, expected: number): string[] {
  return actual === expected ? [] : [`${check} ${actual} != ${expected}`]
}
