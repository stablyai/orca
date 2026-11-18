import type { GitHubPRRefreshCandidate } from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import type { PRRefreshQueue } from './pr-refresh-queue'
import type { PRRefreshRetryState } from './pr-refresh-retry-state'

/** A cadence change re-plans the error retries that were already queued under the old cadence,
 *  from the time each read failed: "off" drops them (a failed read then waits for the next
 *  selection, push, window return or manual refresh), "reduced" and "minimal" move them out, and a
 *  return to a shorter cadence moves them in. Without this a retry armed under Default would still
 *  fire after the host was set to Off. */
export function retimeQueuedErrorRetries(
  queue: PRRefreshQueue,
  retry: PRRefreshRetryState,
  candidateFor: (key: string, candidate: GitHubPRRefreshCandidate) => GitHubPRRefreshCandidate
): void {
  for (const entry of Array.from(queue.values())) {
    if (!entry.errorRetry || entry.reason !== 'visible') {
      continue
    }
    const planned = retry.retimedVisibleErrorRetryAt(
      entry.key,
      candidateFor(entry.key, entry.candidate)
    )
    // No current failure owes it a retry (replaced, or its demand ended): it is not owed.
    if (planned === null) {
      queue.delete(entry.key)
      continue
    }
    const retryAt = Math.max(planned, retry.manualGateUntil(entry.key))
    if (!Number.isFinite(retryAt)) {
      queue.delete(entry.key)
      continue
    }
    entry.dueAt = retryAt
    // The gate set for the old retry time moves with it, so a sooner retry is not held back.
    queue.protectBackgroundUntil(entry.key, retryAt)
  }
}
