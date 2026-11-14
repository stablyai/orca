import { sharedPromiseSettlementWaiters } from '../../../../shared/promise-settlement-waiters'
import { runImmediatePRRefresh } from './pr-refresh-immediate-read'
import type {
  GitHubPRRefreshCandidate,
  GitHubPRRefreshReason,
  PRRefreshOutcome,
  PRSnapshotReply
} from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import type { PreparedPRBranchRead } from '../../client/lookup/pr-for-branch-outcome'
import {
  aliasFromCandidate,
  isBudgetedBackground,
  refreshKey,
  validateCandidate
} from './pr-refresh-candidate-policy'
import {
  PRRefreshEventPublisher,
  type PRRefreshOutcomeObserver
} from './pr-refresh-event-publisher'
import { retimeQueuedErrorRetries } from './pr-refresh-error-retry-retiming'
import { PRRefreshPacing } from './pr-refresh-pacing'
import { PRRefreshQueue } from './pr-refresh-queue'
import { PRRefreshQueueDrainer, type PRRefreshRegistrationCheck } from './pr-refresh-queue-drainer'
import {
  prWatchQueueKey,
  schedulePRWatchEntry,
  type PRWatchJob,
  type PRWatchJobHooks,
  type PRWatchPlan
} from './pr-refresh-watch-jobs'
import { PRRefreshRetryState } from './pr-refresh-retry-state'
import { PRRefreshVisibility } from './pr-refresh-visibility'
import { refreshPRPolicyContext } from '../../client/lookup/pr-quiet-policy-evidence'
import { getPRAutoRefreshCadence } from '../../../../shared/review-refresh-policy'
import {
  deliverablePRBranchOutcome,
  setPRBranchReadCompletion,
  type PRBranchReadResult
} from '../../client/lookup/pr-branch-read-resources'
import { hostedPRReadSettlement } from './hosted-pr-read-settlement'

const retry = new PRRefreshRetryState()
// Dropping an old gate index entry must not forget a visible row's current failure.
const queue = new PRRefreshQueue((key) => {
  if (!visibility.has(key)) {
    retry.reset(key)
  }
})
const pacing = new PRRefreshPacing()
// A row no longer shown owes no retry for its failure (only its rate-limit gate stays), and its
// queued visible read is dropped.
const visibility = new PRRefreshVisibility((key) => {
  retry.releaseFailure(key)
  const entry = queue.get(key)
  if (entry?.reason === 'visible') {
    queue.delete(key)
    events.broadcast({
      aliases: Array.from(entry.aliases.values()),
      reason: 'visible',
      status: 'skipped',
      skippedReason: 'fresh'
    })
  }
})
const events = new PRRefreshEventPublisher()
const drainer = new PRRefreshQueueDrainer(queue, pacing, visibility, retry, events)
setPRBranchReadCompletion((outcome, producer, prepared, request) =>
  drainer.scheduler.reconcileCompletion(outcome, prepared, request, producer)
)

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
  options: { defer?: boolean; plan?: PRWatchPlan } = {}
): void {
  schedulePRWatchEntry(queue, job, candidate, dueAt, options.defer === true, options.plan)
  drainer.schedule()
}

export function cancelPRWatchRead(job: PRWatchJob): void {
  queue.delete(prWatchQueueKey(job))
}

/** A read a paired server made for a client reaches every observer. It takes no queue ownership,
 *  so a desktop read in flight for the same checkout keeps its follow-up. A prepared read is
 *  observed once, by its actual read while that is the newest in scope, and plans a visible row of
 *  its request; its caller still gets its own outcome. */
export async function runHostedPRRead(
  candidate: GitHubPRRefreshCandidate,
  read: (() => Promise<PRRefreshOutcome>) | PreparedPRBranchRead,
  didRead: () => boolean = () => true,
  release: () => void = () => {}
): Promise<PRRefreshOutcome> {
  if (typeof read !== 'function') {
    const owners = { queue, retry, observe: events.observe.bind(events) }
    const settle = hostedPRReadSettlement(owners, candidate, read, false)
    try {
      return (await read.readResult(settle))!.outcome
    } finally {
      read.release()
    }
  }
  try {
    const outcome = await read()
    if (didRead()) {
      events.observe(candidate, outcome)
    }
    return outcome
  } finally {
    release()
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
    // A client that takes receipts gets only the request's current result; another gets its own.
    const outcome = acceptRevalidationOnly
      ? deliverablePRBranchOutcome(prepared, result)
      : result.outcome
    return drainer.hostedJobs.complete(prepared, candidate, outcome, acceptRevalidationOnly)
  }
  return drainer.hostedJobs.readCold(candidate, prepared, acceptRevalidationOnly)
}

export function clearVisiblePRRefreshWindow(windowId: number): void {
  const hadVisibleRefreshes = visibility.clearWindow(windowId)
  pacing.clearActiveBurstWindow(windowId)
  if (hadVisibleRefreshes) {
    queue.retimeVisible((key, candidate) => visibility.candidate(key, candidate))
    drainer.schedule()
  }
}

/** A cadence change moves queued visible follow-ups, error retries and their shared schedules to
 *  the new interval, and the gates of queued host jobs with them; "off" drops them. Under a timed
 *  cadence visible rows then get their automatic work back without waiting for the windows to
 *  report again: a row whose failure is still current gets that failure's own retry, others the
 *  follow-up the cadence gives them. Either stays automatic, so the next Off retires it. */
export function retimePRRefreshesForCadence(): void {
  const failureRetries = retry.retimeErrors(queue)
  queue.retimeVisible((key, candidate) => visibility.candidate(key, candidate))
  retimeQueuedErrorRetries(queue, retry, (key, candidate) => visibility.candidate(key, candidate))
  drainer.hostedJobs.retime()
  drainer.watchJobs.retime()
  const timed = getPRAutoRefreshCadence() !== 'off'
  for (const [windowId, reported] of timed ? visibility.reported() : []) {
    const key = refreshKey(reported)
    const candidate = visibility.candidate(key, reported)
    if (validateCandidate(candidate)) {
      continue
    }
    const failed = failureRetries.get(key)
    const retryAt =
      failed !== undefined && retry.failureMatches(key, candidate) ? failed : undefined
    // Work already queued for the row (its retry, a return or an action) keeps its own reason.
    if (queue.get(key)) {
      continue
    }
    const aliases = [aliasFromCandidate(candidate)]
    if (retryAt === undefined) {
      drainer.scheduler.restoreFollowUp(key, candidate, 40, aliases, windowId)
    } else {
      drainer.scheduler.scheduleErrorRetry(key, candidate, retryAt, 40, aliases, windowId)
    }
  }
  drainer.schedule()
}

export function pruneWorktreePRRefreshAliases(worktreeId: string): void {
  queue.pruneWorktreeAliases(worktreeId)
  visibility.removeWorktree(worktreeId)
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
  const pending = queue.get(key)
  if (pending && reason === 'visible' && candidate.isSelected && priority >= 80) {
    // Foreground exposure keeps retry gates while bypassing the list budget once.
    pending.bypassBackgroundBudget = true
  }
  events.record(enqueued.coalesced ? 'coalesced' : 'enqueued', reason)
  const delay = enqueued.dueAt - Date.now()
  if (!isBudgetedBackground(reason) && delay > 0 && delay <= 5_000) {
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
  const reported = visibility.report(candidates, generation, windowId)
  if (!reported) {
    return
  }
  queue.retimeVisible((key, candidate) => visibility.candidate(key, candidate))
  for (const candidate of candidates) {
    const key = refreshKey(candidate)
    if (validateCandidate(candidate)) {
      enqueuePRRefresh(candidate, 'visible', 40, windowId)
      continue
    }
    // A row still shown as the same request keeps its automatic work; only a return, a new row or
    // another request earns a read the cadence does not give.
    const exposed = reported.exposed.has(key)
    queue.enqueue(visibility.candidate(key, candidate), 'visible', 40, windowId, exposed, {
      routine: !exposed && !reported.changed.has(key)
    })
  }
  drainer.schedule()
}

export function _getVisiblePRRefreshWindowCountForTests(): number {
  return visibility.windowCount
}

export function _getPRRefreshErrorBackoffCountForTests(): number {
  return retry.errorBackoffCount
}

export function _getPRRefreshQueueSizeForTests(): number {
  return queue.size
}

export function _getPRRefreshAliasCountForTests(key: string): number {
  return queue.aliasCount(key)
}

export function refreshPRNow(
  candidate: GitHubPRRefreshCandidate,
  reason: GitHubPRRefreshReason = 'manual',
  options: { userRefresh?: boolean } = {}
): Promise<PRSnapshotReply> {
  return runImmediatePRRefresh(
    { queue, retry, visibility, events, drainer },
    candidate,
    reason,
    options
  )
}
