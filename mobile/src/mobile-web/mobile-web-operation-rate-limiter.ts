import type { MobileWebOperationGrant } from './mobile-web-production-grants'

type RateBucket = { tokens: number; updatedAt: number }

export class MobileWebOperationRateLimiter {
  private readonly buckets = new Map<string, RateBucket>()

  constructor(private readonly now: () => number) {}

  take(key: string, grant: MobileWebOperationGrant): boolean {
    const now = this.now()
    const current = this.buckets.get(key) ?? {
      tokens: grant.limits.rateCapacity,
      updatedAt: now
    }
    const elapsedSeconds = Math.max(0, now - current.updatedAt) / 1000
    current.tokens = Math.min(
      grant.limits.rateCapacity,
      current.tokens + elapsedSeconds * grant.limits.rateRefillPerSecond
    )
    current.updatedAt = now
    if (current.tokens < 1) {
      this.buckets.set(key, current)
      return false
    }
    current.tokens -= 1
    this.buckets.set(key, current)
    return true
  }

  clear(): void {
    this.buckets.clear()
  }
}
