import { performance } from 'node:perf_hooks'

const MAX_PENDING_OPENS = 16
const MAX_OPENS_PER_WINDOW = 128
const OPEN_RATE_WINDOW_MS = 10_000
const MAX_RETAINED_BYTES = 8 * 1024 * 1024

export class BrowserNetworkTunnelResourceBudget {
  private readonly recentOpenAttempts: number[] = []
  private pendingOpenCount = 0
  private retainedBytes = 0
  private lastOpenAttemptAt = Number.NEGATIVE_INFINITY

  constructor(private readonly now: () => number = () => performance.now()) {}

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
    this.retainedBytes += bytes
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
  }
}
