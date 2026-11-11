import type {
  GitHubPRRefreshCandidate,
  PRRefreshOutcome
} from '../../shared/github/pull-request-refresh-types'
import { lookupBackoffDelayMs } from '../source-control/hosted-review-refresh-pacing'
import {
  getPRAutoRefreshCadence,
  type PRAutoRefreshCadence
} from '../../shared/review-refresh-policy'
import { refreshIntervalForCandidate } from './pr-refresh-candidate-policy'

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

  /** Infinity when the cadence is off: an ordinary visible read that failed waits for the next
   *  selection, push, window return or manual refresh, not for a timer. */
  nextVisibleErrorRetryAt(
    key: string,
    candidate: GitHubPRRefreshCandidate,
    cadence: PRAutoRefreshCadence = getPRAutoRefreshCadence()
  ): number {
    const failures = (this.errorBackoff.get(key)?.failures ?? 0) + 1
    if (cadence === 'off') {
      this.errorBackoff.set(key, { failures, retryAt: Number.POSITIVE_INFINITY })
      return Number.POSITIVE_INFINITY
    }
    const interval = refreshIntervalForCandidate(candidate, cadence)
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
    if (!Number.isFinite(retryAt)) {
      return outcome
    }
    const cooldownUntil = outcome.retryDisabledUntil
    return {
      ...outcome,
      nextAutoRetryAt: cooldownUntil !== undefined ? Math.max(retryAt, cooldownUntil) : retryAt
    }
  }
}
