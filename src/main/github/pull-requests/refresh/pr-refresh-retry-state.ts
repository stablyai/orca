import type {
  GitHubPRRefreshCandidate,
  PRRefreshOutcome
} from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import { lookupBackoffDelayMs } from '../../../source-control/hosted-review-refresh-pacing'
import {
  getPRAutoRefreshCadence,
  type PRAutoRefreshCadence
} from '../../../../shared/review-refresh-policy'
import {
  aliasFromCandidate,
  refreshIntervalForCandidate,
  sameAliasRequestIdentity
} from './pr-refresh-candidate-policy'
import type {
  PRReadSettlement,
  PreparedPRBranchRead
} from '../../client/lookup/pr-for-branch-outcome'
import type { PRReadFailureHold } from '../../client/lookup/pr-branch-read-resources'
import type { PRRefreshQueue } from './pr-refresh-queue'

type ErrorBackoff = {
  failures: number
  failedAt: number
  /** The schedule a producer settlement attached to this failure, and how to re-plan it: the gate
   *  that holds its key and whether a timed retry is planned; null once a newer read replaced it. */
  settled?: PRRefreshOutcome
  retime?: () => { gate: number; timed: boolean } | null
  /** Whether the settled failure still owns its request: no newer provider read started, its scope
   *  is unchanged and the exact cache still holds the error it scheduled. */
  current?: () => boolean
  /** The failed provider read's claim, current until a newer read of its resource starts. */
  hold?: PRReadFailureHold
  /** A newer read or a scope change replaced this failure; it owes no automatic retry. */
  revoked?: boolean
  /** The row as it failed; a row now reported with another HEAD or links is another request. */
  candidate?: GitHubPRRefreshCandidate
}

export class PRRefreshRetryState {
  private readonly errorBackoff = new Map<string, ErrorBackoff>()
  private readonly manualRetryGates = new Map<string, number>()

  get errorBackoffCount(): number {
    return this.errorBackoff.size
  }

  reset(key: string): void {
    this.releaseFailure(key)
    this.manualRetryGates.delete(key)
  }

  /** The row's demand ended (no longer visible): its failure owes nothing, though a manual
   *  rate-limit gate still holds. */
  releaseFailure(key: string): void {
    this.errorBackoff.get(key)?.hold?.release()
    this.errorBackoff.delete(key)
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
    const previous = this.errorBackoff.get(key)
    previous?.hold?.release()
    const failures = (previous?.failures ?? 0) + 1
    const failedAt = Date.now()
    this.errorBackoff.set(key, { failures, failedAt })
    return planErrorRetry(candidate, failures, failedAt, cadence)
  }

  /** The retry a failure already earned, planned again under the current cadence from the time
   *  the read failed: a retry queued before the cadence changed must not keep the old timing.
   *  null when no failure of this row's request still owns it; one that lost it is retired. */
  retimedVisibleErrorRetryAt(
    key: string,
    candidate: GitHubPRRefreshCandidate,
    cadence: PRAutoRefreshCadence = getPRAutoRefreshCadence()
  ): number | null {
    const state = this.errorBackoff.get(key)
    if (!state || state.revoked) {
      return null
    }
    if (
      state.current?.() === false ||
      (state.candidate && !sameRequest(state.candidate, candidate))
    ) {
      revoke(state)
      return null
    }
    return planErrorRetry(candidate, state.failures, state.failedAt, cadence)
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

  /** Whether the recorded failure belongs to the row as it is reported now (same HEAD and links);
   *  a failure of another request is released rather than restored for this one. */
  failureMatches(key: string, candidate: GitHubPRRefreshCandidate): boolean {
    const failed = this.errorBackoff.get(key)?.candidate
    if (failed && sameRequest(failed, candidate)) {
      return true
    }
    this.releaseFailure(key)
    return false
  }

  /** Moves every retained error's shared schedule and gate to the current cadence, and returns
   *  when each still-current failure retries under it (none under Off), from its own failure. */
  retimeErrors(queue: PRRefreshQueue): Map<string, number> {
    const retries = new Map<string, number>()
    for (const [key, state] of this.errorBackoff) {
      const plan = state.retime?.()
      if (plan === null) {
        revoke(state)
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

  /**
   * Settles the actual provider read's failure once, before its callers continue: plans the retry
   * it owes and keeps how to re-plan it. A read the exact cache kept also schedules the shared
   * error there; a full read the cache refused still owes its retry through its own claim. A newer
   * read of the request starting retires that retry and its claim, keeping the failure count and
   * rate gate. Other outcomes, and reads with no demand, pass through.
   */
  settleProducerError(
    outcome: PRRefreshOutcome,
    key: string,
    candidate: GitHubPRRefreshCandidate,
    prepared: PreparedPRBranchRead,
    queue: PRRefreshQueue,
    producer: Parameters<PRReadSettlement>[1] = { retained: true },
    demand = true
  ): PRRefreshOutcome {
    if (outcome.kind !== 'upstream-error' || !demand || (!producer.retained && !producer.hold)) {
      return outcome
    }
    const hold = producer.hold?.()
    if (hold && !hold.current()) {
      // A newer read already owns the request: this late failure owes it no retry.
      hold.release()
      return outcome
    }
    const rateLimitedUntil = outcome.retryDisabledUntil ?? 0
    const retryAt = this.nextVisibleErrorRetryAt(key, candidate)
    const state = this.errorBackoff.get(key)!
    const result = this.withErrorSchedule(outcome, retryAt)
    if (producer.retained) {
      prepared.scheduleError(outcome, result)
    }
    state.settled = result
    state.hold = hold
    state.candidate = candidate
    let scheduled = result
    state.current = () =>
      !(hold && !hold.current()) && !(producer.retained && !prepared.accepts(scheduled))
    hold?.onSuperseded(() => {
      if (this.errorBackoff.get(key) === state) {
        revoke(state)
        if (queue.get(key)?.errorRetry) {
          queue.delete(key)
        }
      }
    })
    // Replaces only the error this settlement scheduled; a newer read's result stays.
    state.retime = () => {
      if (!state.current!()) {
        return null
      }
      const planned = planErrorRetry(
        candidate,
        state.failures,
        state.failedAt,
        getPRAutoRefreshCadence()
      )
      if (producer.retained) {
        const next = this.withErrorSchedule(outcome, planned)
        prepared.scheduleError(scheduled, next)
        if (prepared.accepts(next)) {
          scheduled = next
        }
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

function revoke(state: ErrorBackoff): void {
  state.retime = undefined
  state.revoked = true
  state.hold?.release()
}

function sameRequest(left: GitHubPRRefreshCandidate, right: GitHubPRRefreshCandidate): boolean {
  return sameAliasRequestIdentity(aliasFromCandidate(left), aliasFromCandidate(right))
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
