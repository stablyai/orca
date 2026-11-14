import { sharedPromiseSettlementWaiters } from '../../../../shared/promise-settlement-waiters'
import { runImmediatePRRefresh } from './pr-refresh-immediate-read'
import {
  deliverablePRBranchOutcome,
  type PRBranchReadResult
} from '../../client/lookup/pr-branch-read-resources'
import type {
  GitHubPRRefreshCandidate,
  GitHubPRRefreshReason,
  PRRefreshOutcome,
  PRSnapshotReply
} from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import type { PreparedPRBranchRead } from '../../client/lookup/pr-for-branch-outcome'
import {
  aliasFromCandidate,
  refreshKey,
  shouldBroadcastQueued,
  validateCandidate
} from './pr-refresh-candidate-policy'
import type { PRRefreshOutcomeObserver } from './pr-refresh-event-publisher'
import type { PRRefreshRegistrationCheck } from './pr-refresh-queue-drainer'
import {
  prWatchQueueKey,
  schedulePRWatchEntry,
  type PRWatchJob,
  type PRWatchJobHooks
} from './pr-refresh-watch-jobs'
import { refreshPRPolicyContext } from '../../client/lookup/pr-quiet-policy-evidence'

import { drainer, events, pacing, queue, retry, visibility } from './pr-refresh-coordinator-state'
import { registerPRRefreshRequest } from './pr-detail-recovery-coordinator'

export function addPRRefreshOutcomeObserver(observer: PRRefreshOutcomeObserver): () => void {
  return events.addOutcomeObserver(observer)
}

export function setPRRefreshRegistrationCheck(check: PRRefreshRegistrationCheck | null): void {
  drainer.registrationCheck = check
}

export function setPRWatchJobHooks(hooks: PRWatchJobHooks | null): void {
  drainer.watchJobs.setHooks(hooks)
}

/** Queue a watch read; `defer` only moves a queued one later, as another surface just read it. */
export function schedulePRWatchRead(
  job: PRWatchJob,
  candidate: GitHubPRRefreshCandidate,
  dueAt: number,
  options: { defer?: boolean } = {}
): void {
  schedulePRWatchEntry(queue, job, candidate, dueAt, options.defer === true)
  drainer.schedule()
}

export function cancelPRWatchRead(job: PRWatchJob): void {
  queue.delete(prWatchQueueKey(job))
}

/** A read a paired server made for a client reaches every observer. It takes no queue ownership,
 *  so a desktop read in flight for the same checkout keeps its follow-up. */
export async function runHostedPRRead(
  candidate: GitHubPRRefreshCandidate,
  read: (() => Promise<PRRefreshOutcome>) | PreparedPRBranchRead,
  didRead: () => boolean = () => true,
  release: () => void = () => {}
): Promise<PRRefreshOutcome> {
  const settle = registerPRRefreshRequest(candidate, 'h', true)
  try {
    if (typeof read !== 'function') {
      const result = await read.readResult((outcome) => {
        events.observe(candidate, outcome)
        return outcome
      })
      return result!.outcome
    }
    const outcome = await read()
    if (didRead()) {
      events.observe(candidate, outcome)
    }
    return outcome
  } finally {
    settle()
    if (typeof read !== 'function') {
      read.release()
    } else {
      release()
    }
  }
}

export async function runHostedPRSnapshot(
  candidate: GitHubPRRefreshCandidate,
  prepared: PreparedPRBranchRead,
  deadline: number,
  signal?: AbortSignal,
  acceptRevalidationOnly = false
): Promise<PRSnapshotReply> {
  if (prepared.cached() || drainer.hostedJobs.has(prepared)) {
    return drainer.hostedJobs.read(prepared, candidate, deadline, signal, acceptRevalidationOnly)
  }
  if (acceptRevalidationOnly && !prepared.canRetain()) {
    return drainer.hostedJobs.complete(prepared, candidate, null, acceptRevalidationOnly)
  }
  const pending = prepared.pending()
  if (pending) {
    const timeout = new Error('Pull request snapshot wait timed out')
    let result: PRBranchReadResult
    try {
      result = await sharedPromiseSettlementWaiters(pending).wait({
        signal,
        ...(acceptRevalidationOnly
          ? { timeoutMs: Math.max(0, deadline - Date.now()), createTimeoutError: () => timeout }
          : {}),
        createAbortError: () => new Error('Pull request wait was cancelled')
      })
    } catch (error) {
      if (error === timeout) {
        return drainer.hostedJobs.complete(prepared, candidate, null, acceptRevalidationOnly)
      }
      throw error
    }
    return drainer.hostedJobs.complete(
      prepared,
      candidate,
      acceptRevalidationOnly ? deliverablePRBranchOutcome(prepared, result) : result.outcome,
      acceptRevalidationOnly
    )
  }
  const settle = registerPRRefreshRequest(candidate, 'h', false)
  return drainer.hostedJobs.readCold(candidate, prepared, acceptRevalidationOnly).finally(settle)
}

function removeInvisibleVisibleRefreshes(): void {
  const removed = queue.removeInvisibleVisibleEntries((key) => visibility.has(key))
  for (const entry of removed) {
    events.broadcast({
      aliases: Array.from(entry.aliases.values()),
      reason: 'visible',
      status: 'skipped',
      skippedReason: 'fresh'
    })
  }
}

export function clearVisiblePRRefreshWindow(windowId: number): void {
  const hadVisibleRefreshes = visibility.clearWindow(windowId)
  pacing.clearActiveBurstWindow(windowId)
  if (hadVisibleRefreshes) {
    removeInvisibleVisibleRefreshes()
    queue.retimeVisible((key, candidate) => visibility.candidate(key, candidate))
    drainer.schedule()
  }
}

export function pruneWorktreePRRefreshAliases(worktreeId: string): void {
  queue.pruneWorktreeAliases(worktreeId)
}

export function enqueuePRRefresh(
  candidate: GitHubPRRefreshCandidate,
  reason: GitHubPRRefreshReason,
  priority = 0,
  windowId?: number
): void {
  const alias = aliasFromCandidate(candidate)
  const key = refreshKey(candidate)
  const skippedReason = validateCandidate(candidate)
  if (skippedReason) {
    queue.removeInvalidAlias(key, alias)
    events.record('skipped', reason, skippedReason)
    events.broadcast({ aliases: [alias], reason, status: 'skipped', skippedReason })
    return
  }

  const enqueued = queue.enqueue(candidate, reason, priority, windowId)
  if (reason !== 'visible') {
    registerPRRefreshRequest(candidate, null, true)
  }
  const pending = queue.get(key)
  if (pending && reason === 'visible' && candidate.isSelected && priority >= 80) {
    // Foreground exposure keeps retry gates while bypassing the list budget once.
    pending.bypassBackgroundBudget = true
  }
  events.record(enqueued.coalesced ? 'coalesced' : 'enqueued', reason)
  if (shouldBroadcastQueued(reason, enqueued.dueAt)) {
    events.broadcast({ aliases: [enqueued.alias], reason, status: 'queued' })
  }
  drainer.schedule()
}

export function reportVisiblePRRefreshCandidates(
  candidates: GitHubPRRefreshCandidate[],
  generation: number,
  windowId: number
): void {
  refreshPRPolicyContext()
  const newlyExposed = new Set(candidates.map(refreshKey).filter((key) => !visibility.has(key)))
  if (!visibility.report(candidates, generation, windowId)) {
    return
  }
  removeInvisibleVisibleRefreshes()
  queue.retimeVisible((key, candidate) => visibility.candidate(key, candidate))
  for (const candidate of candidates) {
    const key = refreshKey(candidate)
    if (validateCandidate(candidate)) {
      enqueuePRRefresh(candidate, 'visible', 40, windowId)
      continue
    }
    queue.enqueue(
      visibility.candidate(key, candidate),
      'visible',
      40,
      windowId,
      newlyExposed.has(key)
    )
  }
  drainer.schedule()
}

export function refreshPRNow(
  candidate: GitHubPRRefreshCandidate,
  reason: GitHubPRRefreshReason = 'manual',
  options: { userRefresh?: boolean } = {}
): Promise<PRSnapshotReply> {
  const settle = registerPRRefreshRequest(candidate, 'd', true)
  return runImmediatePRRefresh(
    { queue, retry, visibility, events, drainer },
    candidate,
    reason,
    options
  ).finally(settle)
}
