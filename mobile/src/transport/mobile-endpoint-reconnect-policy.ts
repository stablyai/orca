import type { StableLogicalRpcClient } from './stable-logical-rpc-client'

const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 60_000]
const GIVE_UP_AFTER_ATTEMPTS = 12
const TRICKLE_RECONNECT_DELAY_MS = 90_000

/** Owns app-visible reconnect attempts and battery-safe retry cadence. */
export class MobileEndpointReconnectPolicy {
  private attempt = 0
  private publishing = false

  get isPublishingState(): boolean {
    return this.publishing
  }

  reset(): void {
    this.attempt = 0
  }

  publishPassStart(logical: StableLogicalRpcClient): void {
    this.publish(logical, this.attempt === 0 ? 'connecting' : 'reconnecting')
  }

  recordPassFailure(logical: StableLogicalRpcClient): number {
    this.incrementAttempt()
    this.publish(logical, 'reconnecting')
    return this.retryDelay()
  }

  recordReplacementFailure(): number {
    this.incrementAttempt()
    return this.retryDelay()
  }

  retryDelay(): number {
    if (this.attempt >= GIVE_UP_AFTER_ATTEMPTS) {
      return TRICKLE_RECONNECT_DELAY_MS
    }
    return RECONNECT_DELAYS_MS[
      Math.min(Math.max(0, this.attempt - 1), RECONNECT_DELAYS_MS.length - 1)
    ]!
  }

  private incrementAttempt(): void {
    this.attempt = Math.min(GIVE_UP_AFTER_ATTEMPTS, this.attempt + 1)
  }

  private publish(logical: StableLogicalRpcClient, state: 'connecting' | 'reconnecting'): void {
    this.publishing = true
    try {
      logical.publishRouteOwnerState(state, this.attempt)
    } finally {
      this.publishing = false
    }
  }
}
