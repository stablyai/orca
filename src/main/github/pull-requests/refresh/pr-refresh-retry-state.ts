import type {
  GitHubPRRefreshCandidate,
  PRRefreshOutcome
} from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import { lookupBackoffDelayMs } from '../../../source-control/hosted-review-refresh-pacing'
import { refreshIntervalForCandidate } from './pr-refresh-candidate-policy'
import type { PreparedPRBranchRead } from '../../client/lookup/pr-for-branch-outcome'
import type { PRRefreshQueue } from './pr-refresh-queue'

export class PRRefreshRetryState {
  private readonly errorBackoff = new Map<string, { failures: number; retryAt: number }>()
  private readonly manualRetryGates = new Map<string, number>()

  get errorBackoffCount(): number {
    return this.errorBackoff.size
  }

  reset(key: string): void {
    this.errorBackoff.delete(key)
    this.manualRetryGates.delete(key)
  }

  noteManualGate(key: string, outcome: PRRefreshOutcome): void {
    if (outcome.kind === 'upstream-error' && outcome.retryDisabledUntil !== undefined) {
      this.manualRetryGates.set(key, outcome.retryDisabledUntil)
    } else {
      this.manualRetryGates.delete(key)
    }
  }

  manualGateUntil(key: string): number {
    return this.manualRetryGates.get(key) ?? 0
  }

  nextVisibleErrorRetryAt(key: string, candidate: GitHubPRRefreshCandidate): number {
    const failures = (this.errorBackoff.get(key)?.failures ?? 0) + 1
    const interval = refreshIntervalForCandidate(candidate)
    const retryAt =
      Date.now() +
      Math.max(lookupBackoffDelayMs(failures), Number.isFinite(interval) ? interval : 0)
    this.errorBackoff.set(key, { failures, retryAt })
    return retryAt
  }

  withErrorSchedule(outcome: PRRefreshOutcome, retryAt: number): PRRefreshOutcome {
    if (outcome.kind !== 'upstream-error') {
      return outcome
    }
    const cooldownUntil = outcome.retryDisabledUntil
    return {
      ...outcome,
      nextAutoRetryAt: cooldownUntil !== undefined ? Math.max(retryAt, cooldownUntil) : retryAt
    }
  }

  errorFollowUpAt(
    key: string,
    candidate: GitHubPRRefreshCandidate,
    outcome: PRRefreshOutcome,
    visible: boolean
  ): number | undefined {
    return outcome.kind === 'upstream-error'
      ? (outcome.nextAutoRetryAt ??
          (visible ? this.nextVisibleErrorRetryAt(key, candidate) : undefined))
      : undefined
  }

  settleProducerError(
    outcome: PRRefreshOutcome,
    key: string,
    candidate: GitHubPRRefreshCandidate,
    prepared: PreparedPRBranchRead,
    queue: PRRefreshQueue,
    ownsRequest: boolean
  ): PRRefreshOutcome {
    const retryAt = this.nextVisibleErrorRetryAt(key, candidate)
    const result = this.withErrorSchedule(outcome, retryAt)
    prepared.scheduleError(outcome, result)
    if (ownsRequest) {
      queue.protectBackgroundUntil(
        key,
        Math.max(retryAt, outcome.kind === 'upstream-error' ? (outcome.retryDisabledUntil ?? 0) : 0)
      )
    }
    return result
  }
}
