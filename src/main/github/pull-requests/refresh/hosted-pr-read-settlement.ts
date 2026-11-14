import type {
  GitHubPRRefreshCandidate,
  PRRefreshOutcome
} from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import {
  completePRBranchRead,
  type PRReadSettlement,
  type PreparedPRBranchRead
} from '../../client/lookup/pr-branch-read-resources'
import type { PRRefreshQueue } from './pr-refresh-queue'
import type { PRRefreshRetryState } from './pr-refresh-retry-state'

/**
 * Settles a read a paired client's request started, once, and only while it is the newest read of
 * its request in scope: an opted job's failure keeps the job's own retry, the read plans a visible
 * row of its request, and observers see it.
 */
export function hostedPRReadSettlement(
  owners: {
    queue: PRRefreshQueue
    retry: PRRefreshRetryState
    observe: (candidate: GitHubPRRefreshCandidate, outcome: PRRefreshOutcome) => void
  },
  candidate: GitHubPRRefreshCandidate,
  prepared: PreparedPRBranchRead,
  job: boolean
): PRReadSettlement {
  return (outcome, producer) => {
    const settled =
      job && outcome.kind === 'upstream-error'
        ? owners.retry.settleProducerError(
            outcome,
            `hosted::${prepared.key}`,
            { ...candidate, isSelected: false },
            prepared,
            owners.queue
          )
        : outcome
    const own = job ? { ...producer, retained: false } : producer
    completePRBranchRead(settled, own, prepared, candidate)
    owners.observe(candidate, settled)
    return settled
  }
}
