import type { PRRefreshOutcome } from '../../shared/github/pull-request-refresh-types'
import { lookupBackoffDelayMs } from '../source-control/hosted-review-refresh-pacing'

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

  nextVisibleErrorRetryAt(key: string): number {
    const failures = (this.errorBackoff.get(key)?.failures ?? 0) + 1
    const retryAt = Date.now() + lookupBackoffDelayMs(failures)
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
}
