import type { GitHubPRRefreshAlias } from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import type { PreparedPRBranchRead } from '../../client/lookup/pr-for-branch-outcome'
import { isBackground, isBudgetedBackground } from './pr-refresh-candidate-policy'
import type { PRRefreshEventPublisher } from './pr-refresh-event-publisher'
import { type PRRefreshPacing, usesActiveRefreshPacing } from './pr-refresh-pacing'
import type { PRRefreshQueue, PRRefreshQueueEntry } from './pr-refresh-queue'
import type { PRRefreshQueueScheduler } from './pr-refresh-queue-scheduler'
import type { PRWatchJobRunner } from './pr-refresh-watch-jobs'

type PRReadAdmissionOwners = {
  queue: PRRefreshQueue
  pacing: PRRefreshPacing
  events: PRRefreshEventPublisher
  scheduler: PRRefreshQueueScheduler
  watchJobs: PRWatchJobRunner
}

export function admitPreparedPRRead(
  { queue, pacing, events, scheduler, watchJobs }: PRReadAdmissionOwners,
  next: PRRefreshQueueEntry,
  prepared: PreparedPRBranchRead,
  aliases: GitHubPRRefreshAlias[],
  requestSequence: number,
  requestStartedAt: number,
  joinedRead: boolean
): boolean {
  if (!queue.ownsRequest(next.key, requestSequence) || !prepared.isCurrent()) {
    next.hosted?.finish(null)
    prepared.release()
    if (!next.hosted && queue.ownsRequest(next.key, requestSequence)) {
      events.broadcast(
        { aliases, reason: next.reason, status: 'skipped', skippedReason: 'fresh' },
        requestSequence
      )
      if (next.watch) {
        watchJobs.skipped(next)
      } else {
        scheduler.completeWithoutOutcome(
          next.key,
          next.candidate,
          aliases,
          next.priority,
          next.windowId,
          next.foreground
        )
      }
    }
    return false
  }
  if (scheduler.consumeGatedError(next, prepared, requestSequence, requestStartedAt)) {
    prepared.release()
    return false
  }
  if (!next.watch && isBackground(next.reason) && !joinedRead) {
    if (next.bypassBackgroundBudget !== true && isBudgetedBackground(next.reason)) {
      pacing.noteBackgroundStart()
      watchJobs.noteBudgetedStart(next)
    }
    if (usesActiveRefreshPacing(next)) {
      pacing.noteActiveStart(next)
    }
  }
  return true
}
