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
  refreshKey,
  shouldBroadcastQueued,
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
  type PRWatchJobHooks
} from './pr-refresh-watch-jobs'
import { PRRefreshRetryState } from './pr-refresh-retry-state'
import { PRRefreshVisibility } from './pr-refresh-visibility'
import { refreshPRPolicyContext } from '../../client/lookup/pr-quiet-policy-evidence'
import { getPRAutoRefreshCadence } from '../../../../shared/review-refresh-policy'

const retry = new PRRefreshRetryState()
const queue = new PRRefreshQueue((key) => retry.reset(key))
const pacing = new PRRefreshPacing()
const visibility = new PRRefreshVisibility()
const events = new PRRefreshEventPublisher()
const drainer = new PRRefreshQueueDrainer(queue, pacing, visibility, retry, events)

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
  read: () => Promise<PRRefreshOutcome>,
  didRead: () => boolean = () => true,
  release: () => void = () => {}
): Promise<PRRefreshOutcome> {
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
    return drainer.hostedJobs.complete(prepared, candidate, await pending, acceptRevalidationOnly)
  }
  return drainer.hostedJobs.readCold(candidate, prepared, acceptRevalidationOnly)
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

/** A cadence change moves queued visible follow-ups, error retries and their shared schedules to
 *  the new interval, and the gates of queued host jobs with them; "off" drops them. Under a timed
 *  cadence visible rows then get the next read it gives them, so Off back to Default resumes without
 *  waiting for the windows to report again. Off resumes nothing: a row that failed would otherwise
 *  be queued again for its gate, an automatic retry Off does not make. */
export function retimePRRefreshesForCadence(): void {
  retry.retimeErrors(queue)
  queue.retimeVisible((key, candidate) => visibility.candidate(key, candidate))
  retimeQueuedErrorRetries(queue, retry, (key, candidate) => visibility.candidate(key, candidate))
  drainer.hostedJobs.retime()
  const timed = getPRAutoRefreshCadence() !== 'off'
  for (const [windowId, candidate] of timed ? visibility.reported() : []) {
    if (!validateCandidate(candidate)) {
      queue.enqueue(visibility.candidate(refreshKey(candidate), candidate), 'visible', 40, windowId)
    }
  }
  drainer.schedule()
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
): Promise<PRRefreshOutcome> {
  return runImmediatePRRefresh(
    { queue, retry, visibility, events, drainer },
    candidate,
    reason,
    options
  )
}
