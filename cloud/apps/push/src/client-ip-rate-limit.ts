import { PUSH_LIMITS } from '@orca-cloud/push-contract'
import type { Context, MiddlewareHandler } from 'hono'

const REFILL_WINDOW_MS = 60_000
const MAX_TRACKED_IPS = 10_000
const UNKNOWN_CLIENT_IP = 'unknown'

export type ClientIpRateLimiterOptions = {
  capacity?: number
  windowMs?: number
  maxTrackedIps?: number
  now?: () => number
}

type Bucket = { tokens: number; updatedAt: number }

// Cloud Run appends the caller to x-forwarded-for, so the first hop is the real
// client. Off Cloud Run every caller shares one bucket, which throttles rather
// than opens: the alternative would be a free pass for a missing header.
export function readClientIp(context: Context): string {
  const first = context.req.header('x-forwarded-for')?.split(',')[0]?.trim()
  if (first) return first
  return context.req.header('x-real-ip')?.trim() || UNKNOWN_CLIENT_IP
}

// In-memory and per-instance on purpose. A shared counter would put a database
// round trip in front of the only routes an attacker can reach unauthenticated,
// and Cloud Run's instance fan-out only loosens the cap by the instance count.
export class ClientIpRateLimiter {
  private readonly buckets = new Map<string, Bucket>()
  private readonly capacity: number
  private readonly windowMs: number
  private readonly maxTrackedIps: number
  private readonly now: () => number

  constructor(options: ClientIpRateLimiterOptions = {}) {
    this.capacity = options.capacity ?? PUSH_LIMITS.unauthenticatedRequestsPerMinutePerIp
    this.windowMs = options.windowMs ?? REFILL_WINDOW_MS
    this.maxTrackedIps = options.maxTrackedIps ?? MAX_TRACKED_IPS
    this.now = options.now ?? Date.now
  }

  allow(clientIp: string): boolean {
    const now = this.now()
    const tokens = this.tokensAt(this.buckets.get(clientIp), now)
    if (tokens < 1) {
      this.buckets.set(clientIp, { tokens, updatedAt: now })
      return false
    }
    this.buckets.set(clientIp, { tokens: tokens - 1, updatedAt: now })
    this.evict(now)
    return true
  }

  trackedIpCount(): number {
    return this.buckets.size
  }

  private tokensAt(bucket: Bucket | undefined, now: number): number {
    if (!bucket) return this.capacity
    const refilled = ((now - bucket.updatedAt) * this.capacity) / this.windowMs
    return Math.min(this.capacity, bucket.tokens + Math.max(0, refilled))
  }

  private evict(now: number): void {
    if (this.buckets.size <= this.maxTrackedIps) return
    // A bucket that has refilled to capacity is indistinguishable from an
    // absent one, so dropping it changes no decision.
    for (const [clientIp, bucket] of this.buckets) {
      if (this.tokensAt(bucket, now) >= this.capacity) this.buckets.delete(clientIp)
    }
    if (this.buckets.size <= this.maxTrackedIps) return
    // A flood of distinct live IPs can still overflow. The least recently seen
    // are the least likely to be mid-burst.
    const excess = [...this.buckets.entries()]
      .sort((left, right) => left[1].updatedAt - right[1].updatedAt)
      .slice(0, this.buckets.size - this.maxTrackedIps)
    for (const [clientIp] of excess) this.buckets.delete(clientIp)
  }
}

export function clientIpRateLimit(
  limiter: ClientIpRateLimiter,
  onLimited?: () => void
): MiddlewareHandler {
  return async (context, next) => {
    if (!limiter.allow(readClientIp(context))) {
      onLimited?.()
      return context.json({ error: 'rate_limited' }, 429)
    }
    await next()
    return
  }
}
