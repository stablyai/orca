/**
 * GitHub API rate-limit probe.
 *
 * Why: `listWorkItems` fan-out × selected repos plus `countWorkItems` in
 * parallel, plus `listAccessibleProjects` org-walk, can chew through the
 * core (5000/hr) or search (30/min) buckets quickly. Surfacing the remaining
 * budget in the TaskPage header lets users self-regulate before they hit the
 * wall — without actually throttling (which would hurt responsiveness in
 * the common not-near-the-limit case). The probe itself is exempt from
 * rate-limit accounting per GitHub docs.
 *
 * The result is intentionally minimal: we expose just the counts the UI
 * needs (remaining + limit for the three buckets we actually stress). If a
 * future feature needs reset-time countdowns we can add resetAt here.
 */
import type {
  GetRateLimitResult,
  GitHubRateLimitBucket,
  GitHubRateLimitSnapshot
} from '../../shared/types'
import { acquire, release } from './gh-utils'
import { ghExecFileAsync } from '../git/runner'
import {
  clearGhRateLimitBlock,
  getGhRateLimitBlockedUntilMs,
  recordGhPrimaryRateLimit,
  registerGhRateLimitResetProbe,
  type GhRateLimitBucket
} from '../git/gh-rate-limit-breaker'

// Why: GitHub explicitly states `GET /rate_limit` does NOT count against
// any bucket, so the only reason to cache is to avoid spawning a `gh`
// subprocess on every render. 30s is a pragmatic balance — short enough
// that the number in the header feels live, long enough to absorb the
// 1-per-second "is it safe now?" polling pattern UIs tend to fall into.
const RATE_LIMIT_CACHE_TTL_MS = 30_000
let cached: GitHubRateLimitSnapshot | null = null
// Why: failed probes are cached for the same TTL as successes. Refreshes fail
// open past a failed probe, so on a host that can never report a budget (GHES
// with rate limiting disabled 404s every probe) an uncached failure would cost
// a gh subprocess per queued refresh.
let probeFailure: { at: number; error: string } | null = null

type GhRateLimitPayload = {
  resources?: {
    core?: { limit?: number; remaining?: number; reset?: number }
    search?: { limit?: number; remaining?: number; reset?: number }
    graphql?: { limit?: number; remaining?: number; reset?: number }
  }
}

function parseBucket(
  raw:
    | {
        limit?: number
        remaining?: number
        reset?: number
      }
    | undefined
): GitHubRateLimitBucket {
  // Why: if a bucket is absent from the response (old gh, partial response),
  // return 0/0/now so the UI shows a clear "unknown" state (0/0 is
  // unambiguous) rather than a misleading "plenty left" fallback.
  return {
    limit: typeof raw?.limit === 'number' ? raw.limit : 0,
    remaining: typeof raw?.remaining === 'number' ? raw.remaining : 0,
    resetAt: typeof raw?.reset === 'number' ? raw.reset : Math.floor(Date.now() / 1000)
  }
}

/** @internal — test-only */
export function _resetRateLimitCache(): void {
  cached = null
  probeFailure = null
}

// Why: hard-stop thresholds for the circuit breaker. We refuse to issue a new
// gh request when the cached snapshot says the relevant bucket is below this
// floor. Numbers chosen as "enough budget for one user-initiated flow":
// - core/graphql at 50: a typical work-item details fetch + a few mutations
// - search at 2: a search-driven view paginates in chunks of 1; 2 leaves the
//   user one safety click without tipping into the 30/min hard limit
// Below the floor, callers get a synthesized rate_limited error and never
// spawn a gh subprocess.
const MIN_REMAINING_CORE = 50
const MIN_REMAINING_GRAPHQL = 50
const MIN_REMAINING_SEARCH = 2

export type RateLimitBucketKind = 'core' | 'graphql' | 'search'

/**
 * Return a "soft" stop reason if we should refuse to issue a new gh request
 * for the given bucket. Returns null when there's no cached snapshot (we
 * haven't probed yet — fail open) or when the bucket has enough budget left.
 *
 * Why: this is the proactive guard the pill alone cannot provide. The pill is
 * informational; this function actually blocks the spawn. We deliberately keep
 * it advisory (returns a reason, doesn't throw) so callers can format the
 * envelope/error in their own shape.
 */
export function rateLimitGuard(bucket: RateLimitBucketKind):
  | { blocked: false }
  | {
      blocked: true
      remaining: number
      limit: number
      resetAt: number
    } {
  // Why: the runner-level breaker learns about exhaustion from actual 403s,
  // which can happen long before (or without) a snapshot probe — e.g. quota
  // burned by another tool on the same account.
  const breakerBlockedUntilMs = getGhRateLimitBlockedUntilMs(bucket)
  if (breakerBlockedUntilMs !== null) {
    return {
      blocked: true,
      remaining: 0,
      limit: cached?.[bucket].limit ?? 0,
      resetAt: Math.ceil(breakerBlockedUntilMs / 1000)
    }
  }
  if (!cached) {
    return { blocked: false }
  }
  const b = cached[bucket]
  const floor =
    bucket === 'core'
      ? MIN_REMAINING_CORE
      : bucket === 'graphql'
        ? MIN_REMAINING_GRAPHQL
        : MIN_REMAINING_SEARCH
  // Why: a snapshot from before the bucket's reset time describes a window
  // that has already ended — fail open rather than blocking on stale data.
  if (b.resetAt * 1000 <= Date.now()) {
    return { blocked: false }
  }
  // Why: only block when we have a positive limit (limit:0 means "unknown" per
  // parseBucket fallback — don't block on missing data, that would brick the
  // app on a single bad rate_limit response).
  if (b.limit > 0 && b.remaining < floor) {
    return { blocked: true, remaining: b.remaining, limit: b.limit, resetAt: b.resetAt }
  }
  return { blocked: false }
}

/**
 * Decrement the cached `remaining` counter for a bucket after a successful
 * spawn. Why: the canonical numbers come from the next probe, but between
 * probes the cached snapshot would over-report budget if we didn't account
 * for the work we just did. The decrement keeps the circuit breaker honest
 * during a burst (e.g. paginating items) instead of waiting 30s for the cache
 * to expire.
 */
export function noteRateLimitSpend(bucket: RateLimitBucketKind, cost = 1): void {
  if (!cached) {
    return
  }
  const b = cached[bucket]
  if (b.remaining > 0) {
    cached = { ...cached, [bucket]: { ...b, remaining: Math.max(0, b.remaining - cost) } }
  }
}

// Why: when the runner's breaker trips it only knows "blocked", not for how
// long. `gh api rate_limit` is exempt from limits, so one forced probe turns
// the fallback block into the bucket's real reset time (or clears a block
// that a stale fallback would otherwise keep alive). Single-flight: a 90-repo
// 403 burst must refine once, not 90 times.
let resetRefinementInFlight: Promise<void> | null = null

function refineBreakerFromSnapshot(): void {
  if (resetRefinementInFlight) {
    return
  }
  resetRefinementInFlight = (async () => {
    try {
      const result = await getRateLimit({ force: true })
      if (!result.ok) {
        return
      }
      for (const bucket of ['core', 'search', 'graphql'] as GhRateLimitBucket[]) {
        const b = result.snapshot[bucket]
        if (b.limit > 0 && b.remaining <= 0) {
          recordGhPrimaryRateLimit(bucket, b.resetAt * 1000)
        } else if (b.limit > 0) {
          clearGhRateLimitBlock(bucket)
        }
      }
    } finally {
      resetRefinementInFlight = null
    }
  })()
}

registerGhRateLimitResetProbe(() => refineBreakerFromSnapshot())

// Why: a 90-repo fan-out that primes the guard concurrently must resolve to
// one `gh api rate_limit` spawn, not one per repo — the TTL cache alone can't
// dedupe calls that all start before the first probe lands.
let probeInFlight: Promise<GetRateLimitResult> | null = null

export async function getRateLimit(options?: { force?: boolean }): Promise<GetRateLimitResult> {
  if (!options?.force && cached && Date.now() - cached.fetchedAt < RATE_LIMIT_CACHE_TTL_MS) {
    return { ok: true, snapshot: cached }
  }
  if (!options?.force && probeFailure && Date.now() - probeFailure.at < RATE_LIMIT_CACHE_TTL_MS) {
    return { ok: false, error: probeFailure.error }
  }
  if (!options?.force && probeInFlight) {
    return probeInFlight
  }
  const probe = fetchRateLimitSnapshot()
  probeInFlight = probe
  try {
    return await probe
  } finally {
    if (probeInFlight === probe) {
      probeInFlight = null
    }
  }
}

async function fetchRateLimitSnapshot(): Promise<GetRateLimitResult> {
  await acquire()
  try {
    const { stdout } = await ghExecFileAsync(['api', 'rate_limit'], { encoding: 'utf-8' })
    const parsed = JSON.parse(stdout) as GhRateLimitPayload
    const snapshot: GitHubRateLimitSnapshot = {
      core: parseBucket(parsed.resources?.core),
      search: parseBucket(parsed.resources?.search),
      graphql: parseBucket(parsed.resources?.graphql),
      fetchedAt: Date.now()
    }
    cached = snapshot
    probeFailure = null
    return { ok: true, snapshot }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    probeFailure = { at: Date.now(), error: message }
    return { ok: false, error: message }
  } finally {
    release()
  }
}
