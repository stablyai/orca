import { performance } from 'node:perf_hooks'
import type { BrowserNetworkTunnelSessionOptions } from './browser-network-tunnel-stream-state'

const MAX_PENDING_OPENS = 16
const MAX_OPENS_PER_WINDOW = 128
const OPEN_RATE_WINDOW_MS = 10_000
const MAX_RETAINED_BYTES = 8 * 1024 * 1024

export function createBrowserNetworkTunnelResourceBudget(
  options: BrowserNetworkTunnelSessionOptions
): BrowserNetworkTunnelResourceBudget {
  return new BrowserNetworkTunnelResourceBudget(options.now, options.claimAggregateRetainedBytes)
}

export class BrowserNetworkTunnelResourceBudget {
  private readonly recentOpenAttempts: number[] = []
  private pendingOpenCount = 0
  private retainedBytes = 0
  private lastOpenAttemptAt = Number.NEGATIVE_INFINITY
  private readonly aggregateClaims: ({ remaining: number; release: () => void } | undefined)[] = []
  private aggregateClaimHead = 0

  constructor(
    private readonly now: () => number = () => performance.now(),
    private readonly claimAggregateRetainedBytes?: (bytes: number) => (() => void) | null
  ) {}

  admitOpenAttempt(): boolean {
    const observedAt = this.now()
    if (!Number.isFinite(observedAt)) {
      return false
    }
    const admittedAt = Math.max(observedAt, this.lastOpenAttemptAt)
    this.lastOpenAttemptAt = admittedAt
    const cutoff = admittedAt - OPEN_RATE_WINDOW_MS
    while (this.recentOpenAttempts[0] !== undefined && this.recentOpenAttempts[0] <= cutoff) {
      this.recentOpenAttempts.shift()
    }
    if (this.recentOpenAttempts.length >= MAX_OPENS_PER_WINDOW) {
      return false
    }
    this.recentOpenAttempts.push(admittedAt)
    return true
  }

  claimPendingOpen(): (() => void) | null {
    if (this.pendingOpenCount >= MAX_PENDING_OPENS) {
      return null
    }
    this.pendingOpenCount += 1
    let pending = true
    return () => {
      if (!pending) {
        return
      }
      if (this.pendingOpenCount <= 0) {
        throw new Error('Browser tunnel pending-open accounting underflow')
      }
      pending = false
      this.pendingOpenCount -= 1
    }
  }

  reserveRetainedBytes(bytes: number): boolean {
    if (bytes < 0 || bytes > MAX_RETAINED_BYTES - this.retainedBytes) {
      return false
    }
    if (bytes === 0) {
      return true
    }
    let releaseAggregate = (): void => undefined
    if (this.claimAggregateRetainedBytes) {
      const aggregateClaim = this.claimAggregateRetainedBytes(bytes)
      if (!aggregateClaim) {
        return false
      }
      releaseAggregate = aggregateClaim
    }
    this.retainedBytes += bytes
    this.aggregateClaims.push({ remaining: bytes, release: releaseAggregate })
    return true
  }

  claimRetainedBytes(bytes: number): (() => void) | null {
    if (!this.reserveRetainedBytes(bytes)) {
      return null
    }
    let retained = true
    return () => {
      if (!retained) {
        return
      }
      retained = false
      this.releaseRetainedBytes(bytes)
    }
  }

  releaseRetainedBytes(bytes: number): void {
    if (bytes < 0 || bytes > this.retainedBytes) {
      throw new Error('Browser tunnel retained-byte accounting underflow')
    }
    this.retainedBytes -= bytes
    let remaining = bytes
    while (remaining > 0) {
      const claim = this.aggregateClaims[this.aggregateClaimHead]
      if (!claim) {
        throw new Error('Browser tunnel aggregate-byte accounting underflow')
      }
      const released = Math.min(remaining, claim.remaining)
      claim.remaining -= released
      remaining -= released
      if (claim.remaining === 0) {
        claim.release()
        this.aggregateClaims[this.aggregateClaimHead++] = undefined
      }
    }
    if (this.aggregateClaimHead >= 64) {
      this.aggregateClaims.splice(0, this.aggregateClaimHead)
      this.aggregateClaimHead = 0
    }
  }
}
