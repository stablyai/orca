import { admitPreparedPRRead } from './pr-refresh-read-admission'
import {
  deliverablePRBranchOutcome,
  type PRBranchReadResult
} from '../../client/lookup/pr-branch-read-resources'
import { preparePRBranchRead } from '../../client/lookup/pr-for-branch-outcome'
import {
  hostedReviewOptionArgs,
  bypassesFreshnessDelay,
  refreshKey
} from './pr-refresh-candidate-policy'
import type {
  GitHubPRRefreshAlias,
  PRRefreshOutcome
} from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import type { PRRefreshEventPublisher } from './pr-refresh-event-publisher'
import type { PRRefreshPacing } from './pr-refresh-pacing'
import type { PRRefreshQueue, PRRefreshQueueEntry } from './pr-refresh-queue'
import type { PRRefreshQueueScheduler } from './pr-refresh-queue-scheduler'
import type { PRWatchJobRunner } from './pr-refresh-watch-jobs'
import {
  prRefreshRequestDigest,
  queuedRequestId,
  type PRRefreshRequestRegistry
} from './pr-refresh-request-registry'

/** Queue admission and producer settlement keep recovery predecessors attached to the actual read. */
export async function readQueuedPRRefresh(
  {
    queue,
    pacing,
    events,
    scheduler,
    watchJobs,
    requests
  }: {
    queue: PRRefreshQueue
    pacing: PRRefreshPacing
    events: PRRefreshEventPublisher
    scheduler: PRRefreshQueueScheduler
    watchJobs: PRWatchJobRunner
    requests: PRRefreshRequestRegistry
  },
  next: PRRefreshQueueEntry,
  aliases: GitHubPRRefreshAlias[],
  requestSequence: number,
  requestStartedAt: number,
  joinedRead: Promise<PRBranchReadResult> | null | undefined
): Promise<PRRefreshOutcome | null> {
  if (next.hosted) {
    next.hosted.running = true
  }
  const prepared =
    next.hosted?.prepared ??
    (await preparePRBranchRead(
      next.candidate.repoPath,
      next.candidate.branch,
      next.candidate.linkedPRNumber ?? null,
      next.candidate.connectionId ?? null,
      next.candidate.linkedPRNumber == null ? (next.candidate.fallbackPRNumber ?? null) : null,
      ...hostedReviewOptionArgs(next.candidate, next.reason, {
        watchPRKey: next.watch?.prKey
      })
    ))
  joinedRead ??= bypassesFreshnessDelay(next.reason) ? undefined : prepared.pending()
  const admitted = admitPreparedPRRead(
    { queue, pacing, events, scheduler, watchJobs },
    next,
    prepared,
    aliases,
    requestSequence,
    requestStartedAt,
    Boolean(joinedRead)
  )
  if (!admitted) {
    return null
  }
  const settle = scheduler.settleRead(
    next.key,
    next.candidate,
    aliases,
    prepared,
    requestSequence,
    Boolean(next.hosted)
  )
  const requestId = queuedRequestId(next)
  requests.start({
    requestId,
    slotKey: refreshKey(next.candidate),
    registrationOrder: next.queuedAt,
    identityDigest: prRefreshRequestDigest(next.candidate, next.watch)
  })
  const result = await (joinedRead ?? prepared.readResult(settle, Boolean(next.hosted))).finally(
    () => requests.settle(requestId)
  )
  const outcome = result ? deliverablePRBranchOutcome(prepared, result) : null
  if (!outcome) {
    scheduler.finishWithoutOutcome(next, aliases, requestSequence)
    return null
  }
  if (
    next.hosted &&
    (!next.hosted.prepared.isCurrent() || !next.hosted.prepared.accepts(outcome))
  ) {
    next.hosted.finish(null)
    return null
  }
  return outcome
}
