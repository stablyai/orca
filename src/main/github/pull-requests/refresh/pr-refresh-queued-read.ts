import type {
  GitHubPRRefreshAlias,
  PRRefreshOutcome
} from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import {
  preparePRBranchRead,
  type PreparedPRBranchRead,
  type PRReadSettlement
} from '../../client/lookup/pr-for-branch-outcome'
import { completePRBranchRead } from '../../client/lookup/pr-branch-read-resources'
import {
  bypassesFreshnessDelay,
  candidateReadRequest,
  isBackground,
  refreshKey
} from './pr-refresh-candidate-policy'
import {
  prRefreshRequestDigest,
  queuedRequestId,
  type PRRefreshRequestRegistry
} from './pr-refresh-request-registry'
import type { PRRefreshQueue, PRRefreshQueueEntry } from './pr-refresh-queue'
import type { PRRefreshRetryState } from './pr-refresh-retry-state'
import type { PRRefreshVisibility } from './pr-refresh-visibility'
import type { PRRefreshEventPublisher } from './pr-refresh-event-publisher'
import type { PRRefreshQueueScheduler } from './pr-refresh-queue-scheduler'
import type { PRRefreshAdmission } from './pr-refresh-admission'
import { deliverLocalPRRead } from './pr-refresh-local-delivery'

type Owners = {
  queue: PRRefreshQueue
  retry: PRRefreshRetryState
  visibility: PRRefreshVisibility
  events: PRRefreshEventPublisher
  scheduler: PRRefreshQueueScheduler
  admission: PRRefreshAdmission
  requests: PRRefreshRequestRegistry
}
export async function readQueuedPRRefresh(
  { queue, retry, visibility, events, scheduler, admission, requests }: Owners,
  next: PRRefreshQueueEntry,
  aliases: GitHubPRRefreshAlias[],
  requestSequence: number,
  requestStartedAt: number,
  joinedRead: ReturnType<PreparedPRBranchRead['pending']> | undefined
): Promise<PRRefreshOutcome | null> {
  if (next.hosted) {
    next.hosted.running = true
  }
  const prepared =
    next.hosted?.prepared ??
    (await preparePRBranchRead(
      ...candidateReadRequest(next.candidate, next.reason, { watchPRKey: next.watch?.prKey })
    ))
  // Automatic work joins a read already running for its request; a user's action reads fresh.
  joinedRead ??= bypassesFreshnessDelay(next.reason) ? undefined : prepared.pending()
  const settle: PRReadSettlement = (outcome, producer) => {
    if (!prepared.isCurrent()) {
      return outcome
    }
    // A host job's failure keeps its job's own finite lifetime, so it takes no retry claim.
    const settled = retry.settleProducerError(
      outcome,
      next.key,
      next.hosted
        ? { ...next.candidate, isSelected: false }
        : visibility.candidate(next.key, next.candidate),
      prepared,
      queue,
      next.hosted ? { retained: producer.retained } : producer,
      Boolean(next.hosted) || visibility.has(next.key),
      () => queue.ownsRequest(next.key, requestSequence)
    )
    events.observe(next.candidate, settled, aliases)
    // A host job's read also plans the visible row of the same request, under its own claim.
    const unretained = { ...producer, retained: false }
    if (next.hosted) {
      completePRBranchRead(settled, unretained, prepared, next.candidate)
    }
    return settled
  }
  // Nothing is awaited from this check to the provider start, so it sees current state.
  if (
    !next.hosted &&
    !admission.admitPreparedRead(next, prepared, requestSequence, requestStartedAt)
  ) {
    return null
  }
  if (!next.watch && isBackground(next.reason) && !joinedRead) {
    admission.chargeBudget(next)
  }
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
  if (
    !result ||
    (next.hosted &&
      (!next.hosted.prepared.isCurrent() ||
        !next.hosted.prepared.accepts(result.outcome) ||
        !queue.ownsRequest(next.key, requestSequence)))
  ) {
    next.hosted?.finish(null)
    return null
  }
  const read = {
    ...next,
    // A user's action or a validated return stays owed; automatic work follows the cadence.
    foreground: next.foreground === true || bypassesFreshnessDelay(next.reason),
    aliases,
    requestSequence,
    requestStartedAt
  }
  const owners = { queue: queue, events: events, scheduler: scheduler }
  const outcome =
    next.hosted || next.watch ? result.outcome : deliverLocalPRRead(owners, read, prepared, result)

  return outcome
}
