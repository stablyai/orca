import type { Context, MiddlewareHandler } from 'hono'

type Bucket = { tokens: number; updatedAt: number }

// Per-instance token buckets keyed by client address or account; capacity scales with instances.
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>()

  constructor(
    private readonly capacityPerMinute: number,
    private readonly now: () => number,
    private readonly maxKeys = 10_000
  ) {}

  allow(key: string): boolean {
    const now = this.now()
    const bucket = this.buckets.get(key)
    const refilled = bucket
      ? Math.min(
          this.capacityPerMinute,
          bucket.tokens + (Math.max(0, now - bucket.updatedAt) * this.capacityPerMinute) / 60_000
        )
      : this.capacityPerMinute
    // Re-inserting keeps the map in recency order, so the oldest key is evicted first.
    this.buckets.delete(key)
    this.buckets.set(key, { tokens: refilled >= 1 ? refilled - 1 : refilled, updatedAt: now })
    if (this.buckets.size > this.maxKeys) {
      const oldest = this.buckets.keys().next().value
      if (oldest !== undefined) {
        this.buckets.delete(oldest)
      }
    }
    return refilled >= 1
  }
}

// Read from the right, as push does: Cloud Run appends the peer, earlier entries can be forged.
export function readClientIp(context: Context, trustedProxyHops: number): string {
  const hops = (context.req.header('x-forwarded-for') ?? '')
    .split(',')
    .map((hop) => hop.trim())
    .filter((hop) => hop.length > 0)
  return hops[hops.length - 1 - trustedProxyHops] ?? 'unknown'
}

export function limitByClientIp(limiter: RateLimiter, trustedProxyHops: number): MiddlewareHandler {
  return async (context, next) => {
    if (!limiter.allow(readClientIp(context, trustedProxyHops))) {
      return context.json({ error: 'rate_limited' }, 429)
    }
    await next()
  }
}
