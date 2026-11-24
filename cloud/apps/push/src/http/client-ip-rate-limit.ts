import { PUSH_LIMITS } from '@orca-cloud/push-contract/push-limits'
import type { Context, MiddlewareHandler } from 'hono'
import {
  canonicalIp,
  parseTrustedProxy,
  rangeContains,
  type TrustedProxyRange
} from './trusted-proxy-addresses.js'

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

export type ClientIpPolicy = {
  trustedProxyHops: number
  /** Canonical addresses only a proxy in front of this service appends, such as the load balancer's own address. */
  trustedProxyAddresses: ReadonlySet<string>
  /** Configured networks a proxy appends from, such as an IPv6 forwarding rule's /64. */
  trustedProxyRanges: readonly TrustedProxyRange[]
}

/** Entries are single addresses or CIDR ranges, already validated by config or DNS. */
export function clientIpPolicy(config: {
  trustedProxyHops: number
  trustedProxyAddresses: readonly string[]
}): ClientIpPolicy {
  const addresses = new Set<string>()
  const ranges: TrustedProxyRange[] = []
  for (const entry of config.trustedProxyAddresses) {
    const parsed = parseTrustedProxy(entry)
    if (!parsed.ok) throw new Error(`Invalid trusted proxy ${entry}: ${parsed.reason}`)
    if (parsed.proxy.kind === 'address') addresses.add(parsed.proxy.address)
    else ranges.push(parsed.proxy.range)
  }
  return {
    trustedProxyHops: config.trustedProxyHops,
    trustedProxyAddresses: addresses,
    trustedProxyRanges: ranges
  }
}

export function describeClientIpPolicy(policy: ClientIpPolicy): {
  trustedProxyHops: number
  trustedProxyAddresses: string[]
  trustedProxyRanges: string[]
} {
  return {
    trustedProxyHops: policy.trustedProxyHops,
    trustedProxyAddresses: [...policy.trustedProxyAddresses],
    trustedProxyRanges: policy.trustedProxyRanges.map((range) => range.text)
  }
}

function isTrustedProxy(hop: string, policy: ClientIpPolicy): boolean {
  const address = canonicalIp(hop)
  // canonicalIp unmaps ::ffff:a.b.c.d to IPv4, so IPv6 ranges check the hop as sent.
  return (
    policy.trustedProxyAddresses.has(address) ||
    policy.trustedProxyRanges.some((range) =>
      rangeContains(range, range.family === 6 ? hop : address)
    )
  )
}

// Read from the right: Google's front end appends the peer, while callers can forge earlier entries. Skip the trusted hop count and any trailing hop that is a trusted proxy's address or inside a trusted range, so a load balancer's address never becomes everyone's shared bucket; short chains share the throttled fallback bucket.
export function clientIpFromForwardedFor(
  header: string | undefined,
  policy: ClientIpPolicy
): string {
  const hops =
    header
      ?.split(',')
      .map((hop) => hop.trim())
      .filter((hop) => hop.length > 0) ?? []
  let index = hops.length - 1
  for (let skipped = 0; index >= 0; index--, skipped++) {
    const trusted = skipped < policy.trustedProxyHops || isTrustedProxy(hops[index]!, policy)
    if (!trusted) break
  }
  return hops[index] ?? UNKNOWN_CLIENT_IP
}

export function readClientIp(context: Context, policy: ClientIpPolicy): string {
  return clientIpFromForwardedFor(context.req.header('x-forwarded-for'), policy)
}

// Per-instance admission avoids a database round trip; capacity scales with instance count.
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

  available(clientIp: string): boolean {
    return this.tokensAt(this.buckets.get(clientIp), this.now()) >= 1
  }

  allow(clientIp: string): boolean {
    const now = this.now()
    const tokens = this.tokensAt(this.buckets.get(clientIp), now)
    this.buckets.delete(clientIp)
    this.buckets.set(clientIp, { tokens: tokens < 1 ? tokens : tokens - 1, updatedAt: now })
    if (this.buckets.size > this.maxTrackedIps) {
      const oldest = this.buckets.keys().next().value
      if (oldest !== undefined) this.buckets.delete(oldest)
    }
    return tokens >= 1
  }

  trackedIpCount(): number {
    return this.buckets.size
  }

  private tokensAt(bucket: Bucket | undefined, now: number): number {
    if (!bucket) return this.capacity
    const refilled = ((now - bucket.updatedAt) * this.capacity) / this.windowMs
    return Math.min(this.capacity, bucket.tokens + Math.max(0, refilled))
  }
}

export type ClientIpRateLimitOptions = {
  policy: ClientIpPolicy
  onLimited?: () => void
}

export function clientIpRateLimit(
  limiter: ClientIpRateLimiter,
  options: ClientIpRateLimitOptions
): MiddlewareHandler {
  return async (context, next) => {
    if (!limiter.allow(readClientIp(context, options.policy))) {
      options.onLimited?.()
      return context.json({ error: 'rate_limited' }, 429)
    }
    await next()
    return
  }
}
