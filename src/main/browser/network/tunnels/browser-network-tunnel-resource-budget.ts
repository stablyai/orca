import { performance } from 'node:perf_hooks'
import {
  BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES,
  type BrowserNetworkTunnelSessionOptions
} from './browser-network-tunnel-stream-state'

// Rapid browsing across four heavy pages measured 302 opens in 10 s.
const MAX_OPENS_PER_WINDOW = 1024
const OPEN_RATE_WINDOW_MS = 10_000
// On a slow link every active stream can pin a full window of retained bytes, so the session
// limit scales with the negotiated window to keep the same concurrent-stream headroom. The
// legacy floor equals the previous fixed 8 MiB limit (32 legacy windows).
const MIN_RETAINED_BYTES = 8 * 1024 * 1024
const RETAINED_WINDOWS_PER_SESSION = 16

export function createBrowserNetworkTunnelResourceBudget(
  options: BrowserNetworkTunnelSessionOptions
): BrowserNetworkTunnelResourceBudget {
  return new BrowserNetworkTunnelResourceBudget(
    options.now,
    options.claimAggregateRetainedBytes,
    options.receiveWindowBytes
  )
}

export class BrowserNetworkTunnelResourceBudget {
  private readonly recentOpenAttempts: number[] = []
  private readonly maxRetainedBytes: number
  private retainedBytes = 0
  private lastOpenAttemptAt = Number.NEGATIVE_INFINITY
  private readonly aggregateClaims: ({ remaining: number; release: () => void } | undefined)[] = []
  private aggregateClaimHead = 0

  constructor(
    private readonly now: () => number = () => performance.now(),
    private readonly claimAggregateRetainedBytes?: (bytes: number) => (() => void) | null,
    receiveWindowBytes: number = BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES
  ) {
    this.maxRetainedBytes = Math.max(
      MIN_RETAINED_BYTES,
      RETAINED_WINDOWS_PER_SESSION * receiveWindowBytes
    )
  }

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

  reserveRetainedBytes(bytes: number): boolean {
    if (bytes < 0 || bytes > this.maxRetainedBytes - this.retainedBytes) {
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
