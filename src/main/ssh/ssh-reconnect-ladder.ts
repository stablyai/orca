import { MIN_SSH_RELAY_GRACE_PERIOD_SECONDS } from '../../shared/ssh-types'
import { CONNECT_TIMEOUT_MS, RECONNECT_BACKOFF_MS } from './connection/ssh-connection-timing'

// A connection that held this long is treated as healthy, so the next drop restarts the delay ladder.
export const STABLE_CONNECTION_MS = 60_000
// Existing-relay attach and one bounded PTY reattach attempt each allow 10s.
export const RELAY_REESTABLISH_BUDGET_MS = 20_000

/** Cap flap delay within minimum relay grace after handshake/reattach budgets, or retry could arrive after relay shutdown destroys PTYs. */
export const FLAP_DELAY_CAP_MS = (() => {
  const budgetMs =
    MIN_SSH_RELAY_GRACE_PERIOD_SECONDS * 1000 - CONNECT_TIMEOUT_MS - RELAY_REESTABLISH_BUDGET_MS
  const fitting = RECONNECT_BACKOFF_MS.filter((delayMs) => delayMs < budgetMs)
  return fitting.length > 0 ? Math.max(...fitting) : RECONNECT_BACKOFF_MS[0]
})()

type SshReconnectDecision =
  | { kind: 'retry'; delayMs: number; attemptIndex: number }
  | { kind: 'give-up' }

/** Advance delay for every retry, but count only failed handshakes toward give-up; flapping successful connects still back off without exhausting failures. */
export class SshReconnectLadder {
  private delayIndex = 0
  private consecutiveFailedAttempts = 0
  private connectedAtMs: number | null = null

  next(nowMs: number): SshReconnectDecision {
    const connectedAt = this.connectedAtMs
    // Consume stable-connect reset once; never reset again mid-outage.
    this.connectedAtMs = null
    if (connectedAt !== null && nowMs - connectedAt >= STABLE_CONNECTION_MS) {
      this.delayIndex = 0
    }
    if (this.consecutiveFailedAttempts >= RECONNECT_BACKOFF_MS.length) {
      return { kind: 'give-up' }
    }
    const attemptIndex = Math.min(this.delayIndex, RECONNECT_BACKOFF_MS.length - 1)
    this.delayIndex = attemptIndex + 1
    const tableDelayMs = RECONNECT_BACKOFF_MS[attemptIndex]
    // Clamp only live-relay flaps to grace; failed handshakes use full dead-host backoff.
    const delayMs =
      this.consecutiveFailedAttempts === 0
        ? Math.min(tableDelayMs, FLAP_DELAY_CAP_MS)
        : tableDelayMs
    return { kind: 'retry', delayMs, attemptIndex }
  }

  get failedAttemptStreak(): number {
    return this.consecutiveFailedAttempts
  }

  markConnected(nowMs: number): void {
    this.consecutiveFailedAttempts = 0
    this.connectedAtMs = nowMs
  }

  markAttemptFailed(): void {
    this.consecutiveFailedAttempts += 1
    this.connectedAtMs = null
  }

  reset(): void {
    this.delayIndex = 0
    this.consecutiveFailedAttempts = 0
    this.connectedAtMs = null
  }
}
