import type {
  GitHubPRRefreshAlias,
  GitHubPRRefreshCandidate,
  GitHubPRRefreshReason,
  PRRefreshOutcome
} from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import {
  deliverablePRBranchOutcome,
  type PRBranchReadResult,
  type PreparedPRBranchRead
} from '../../client/lookup/pr-branch-read-resources'
import type { PRRefreshEventPublisher } from './pr-refresh-event-publisher'
import type { PRRefreshQueue } from './pr-refresh-queue'
import type { PRRefreshQueueScheduler } from './pr-refresh-queue-scheduler'

export type LocalPRReadDelivery = {
  key: string
  candidate: GitHubPRRefreshCandidate
  aliases: GitHubPRRefreshAlias[]
  reason: GitHubPRRefreshReason
  priority: number
  windowId?: number
  /** A return or a user's refresh: its demand is to show current data now, not on a timer. */
  foreground: boolean
  requestSequence: number
  requestStartedAt: number
}

/**
 * Ends a local queued or immediate read whose provider read finished, whether it ran that read or
 * joined it. Returns its own outcome when that is still the newest read of its request and the
 * request is still this consumer's, for the caller to publish and plan from. Otherwise it plans
 * nothing from it: it shows a newer read's accepted result if one finished; or, while it still
 * owns the request, it ends that request at its own sequence without data and keeps the row's
 * demand queued, so the newer result reaches the row later. It never publishes a replaced result.
 */
export function deliverLocalPRRead(
  owners: {
    readonly queue: PRRefreshQueue
    readonly events: PRRefreshEventPublisher
    readonly scheduler: Pick<PRRefreshQueueScheduler, 'restoreFollowUp'>
  },
  read: LocalPRReadDelivery,
  prepared: Pick<PreparedPRBranchRead, 'isCurrent' | 'cached'>,
  result: PRBranchReadResult
): PRRefreshOutcome | null {
  const { key, aliases, reason, requestSequence, requestStartedAt } = read
  const delivered = deliverablePRBranchOutcome(prepared, result)
  const owned = owners.queue.ownsRequest(key, requestSequence)
  if (owned && delivered === result.outcome) {
    return result.outcome
  }
  if (delivered) {
    owners.events.broadcast(
      { aliases, reason, outcome: delivered, requestStartedAt },
      requestSequence
    )
  } else if (owned) {
    // Its own sequence: a newer request of the row stays the one the renderer shows loading.
    owners.events.broadcast(
      { aliases, reason, status: 'skipped', skippedReason: 'fresh' },
      requestSequence
    )
    owners.scheduler.restoreFollowUp(
      key,
      read.candidate,
      read.priority,
      aliases,
      read.windowId,
      read.foreground
    )
  }
  return null
}
