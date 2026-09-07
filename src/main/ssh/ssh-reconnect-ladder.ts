import { MIN_SSH_RELAY_GRACE_PERIOD_SECONDS } from '../../shared/ssh-types'
import { CONNECT_TIMEOUT_MS, RECONNECT_BACKOFF_MS } from './ssh-connection-utils'

// A connection that held this long is treated as healthy, so the next drop restarts the delay ladder.
export const STABLE_CONNECTION_MS = 60_000
// Existing-relay attach and one bounded PTY reattach attempt each allow 10s.
export const RELAY_REESTABLISH_BUDGET_MS = 20_000

/**
 * Why: a flap leaves the remote relay in grace, and the shortest grace a target can configure is
 * MIN_SSH_RELAY_GRACE_PERIOD_SECONDS. Retrying later than this cap would let even a full-length
 * handshake plus relay/mux re-establishment finish after grace expires, so the relay would shut
 * down and take every remote PTY with it. Raising the backoff past this bound changes nothing.
 */
export const FLAP_DELAY_CAP_MS = (() => {
  const budgetMs =
    MIN_SSH_RELAY_GRACE_PERIOD_SECONDS * 1000 - CONNECT_TIMEOUT_MS - RELAY_REESTABLISH_BUDGET_MS
  const fitting = RECONNECT_BACKOFF_MS.filter((delayMs) => delayMs < budgetMs)
  return fitting.length > 0 ? Math.max(...fitting) : RECONNECT_BACKOFF_MS[0]
})()

export type SshReconnectDecision =
  | { kind: 'retry'; delayMs: number; attemptIndex: number }
  | { kind: 'give-up' }

/**
 * Why two counters: `delayIndex` advances on every scheduled retry (flap or handshake failure) so a
 * host that keeps dropping after a successful handshake still backs off, while
 * `consecutiveFailedAttempts` advances only on a failed connect attempt so 'reconnection-failed'
 * stays reachable exactly after RECONNECT_BACKOFF_MS.length failed handshakes — never after flaps.
 */
export class SshReconnectLadder {
  private delayIndex = 0
  private consecutiveFailedAttempts = 0
  private connectedAtMs: number | null = null

  next(nowMs: number): SshReconnectDecision {
    const connectedAt = this.connectedAtMs
    // Why: consume it — one reset per connection, never a rolling reset mid-outage (the table sums past the window).
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
    // Why: only a flap (no failed handshake) means the remote relay is alive and burning grace; a dead
    // host keeps the full table because nothing over there is waiting for us.
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
