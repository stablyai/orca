import type {
  GitHubPRRefreshCandidate,
  PRRefreshOutcome
} from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import { lookupBackoffDelayMs } from '../../../source-control/hosted-review-refresh-pacing'
import {
  getPRAutoRefreshCadence,
  type PRAutoRefreshCadence
} from '../../../../shared/review-refresh-policy'
import { refreshIntervalForCandidate } from './pr-refresh-candidate-policy'
import type { PreparedPRBranchRead } from '../../client/lookup/pr-for-branch-outcome'
import type { PRRefreshQueue } from './pr-refresh-queue'

type ErrorBackoff = {
  failures: number
  failedAt: number
  /** The schedule a producer settlement attached to this failure, and how to re-plan it: the gate
   *  that holds its key and whether a timed retry is planned; null once a newer read replaced it. */
  settled?: PRRefreshOutcome
  retime?: () => { gate: number; timed: boolean } | null
}

export class PRRefreshRetryState {
  private readonly errorBackoff = new Map<string, ErrorBackoff>()
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
    const failedAt = Date.now()
    this.errorBackoff.set(key, { failures, failedAt })
    return planErrorRetry(candidate, failures, failedAt, cadence)
  }

  /** The retry a failure already earned, planned again under the current cadence from the time
   *  the read failed: a retry queued before the cadence changed must not keep the old timing.
   *  null when no failure is recorded for the key. */
  retimedVisibleErrorRetryAt(
    key: string,
    candidate: GitHubPRRefreshCandidate,
    cadence: PRAutoRefreshCadence = getPRAutoRefreshCadence()
  ): number | null {
    const state = this.errorBackoff.get(key)
    return state ? planErrorRetry(candidate, state.failures, state.failedAt, cadence) : null
  }

  /** How long a failed key stays closed to background reads. Off plans no retry, yet holds the key
   *  as long as Default would, so a repeated report never re-reads a failure faster than Default. */
  errorGateAt(key: string, candidate: GitHubPRRefreshCandidate, retryAt: number): number {
    if (Number.isFinite(retryAt)) {
      return retryAt
    }
    const state = this.errorBackoff.get(key)
    return state ? planErrorRetry(candidate, state.failures, state.failedAt, 'default') : Date.now()
  }

  /** Moves every retained error's shared schedule and gate to the current cadence, and returns
   *  when each still-current failure retries under it (none under Off), from its own failure. */
  retimeErrors(queue: PRRefreshQueue): Map<string, number> {
    const retries = new Map<string, number>()
    for (const [key, state] of this.errorBackoff) {
      const plan = state.retime?.()
      if (plan === null) {
        state.retime = undefined
      } else if (plan !== undefined) {
        const gate = Math.max(plan.gate, this.manualGateUntil(key))
        queue.protectBackgroundUntil(key, gate)
        if (plan.timed) {
          retries.set(key, gate)
        }
      }
    }
    return retries
  }

  withErrorSchedule(outcome: PRRefreshOutcome, retryAt: number): PRRefreshOutcome {
    if (outcome.kind !== 'upstream-error') {
      return outcome
    }
    if (!Number.isFinite(retryAt)) {
      // Off: no automatic retry, though a rate limit still gates a manual one.
      const { nextAutoRetryAt: _unscheduled, ...unscheduled } = outcome
      return unscheduled
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
    if (outcome.kind !== 'upstream-error') {
      return undefined
    }
    if (this.errorBackoff.get(key)?.settled === outcome) {
      return outcome.nextAutoRetryAt ?? Number.POSITIVE_INFINITY
    }
    const scheduled = getPRAutoRefreshCadence() === 'off' ? undefined : outcome.nextAutoRetryAt
    return scheduled ?? (visible ? this.nextVisibleErrorRetryAt(key, candidate) : undefined)
  }

  settleProducerError(
    outcome: PRRefreshOutcome,
    key: string,
    candidate: GitHubPRRefreshCandidate,
    prepared: PreparedPRBranchRead,
    queue: PRRefreshQueue
  ): PRRefreshOutcome {
    const rateLimitedUntil =
      outcome.kind === 'upstream-error' ? (outcome.retryDisabledUntil ?? 0) : 0
    const retryAt = this.nextVisibleErrorRetryAt(key, candidate)
    const state = this.errorBackoff.get(key)!
    const result = this.withErrorSchedule(outcome, retryAt)
    prepared.scheduleError(outcome, result)
    state.settled = result
    let scheduled = result
    // Replaces only the error this settlement scheduled; a newer read's result stays.
    state.retime = () => {
      if (!prepared.accepts(scheduled)) {
        return null
      }
      const planned = planErrorRetry(
        candidate,
        state.failures,
        state.failedAt,
        getPRAutoRefreshCadence()
      )
      const next = this.withErrorSchedule(outcome, planned)
      prepared.scheduleError(scheduled, next)
      if (prepared.accepts(next)) {
        scheduled = next
      }
      return {
        gate: Math.max(this.errorGateAt(key, candidate, planned), rateLimitedUntil),
        timed: Number.isFinite(planned)
      }
    }
    queue.protectBackgroundUntil(
      key,
      Math.max(this.errorGateAt(key, candidate, retryAt), rateLimitedUntil)
    )
    return result
  }
}

function planErrorRetry(
  candidate: GitHubPRRefreshCandidate,
  failures: number,
  failedAt: number,
  cadence: PRAutoRefreshCadence
): number {
  if (cadence === 'off') {
    return Number.POSITIVE_INFINITY
  }
  const interval = refreshIntervalForCandidate(candidate, cadence)
  return (
    failedAt + Math.max(lookupBackoffDelayMs(failures), Number.isFinite(interval) ? interval : 0)
  )
}
