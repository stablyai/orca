/**
 * GitHub API rate-limit probe.
 *
 * Why: heavy fan-out (listWorkItems × repos, org-walks) can drain the core/search buckets; surfacing remaining budget lets users self-regulate rather than throttle.
 * The probe itself is exempt from rate-limit accounting per GitHub docs.
 */
import type {
  GetRateLimitResult,
  GitHubRateLimitBucket,
  GitHubRateLimitSnapshot
} from '../../shared/types'
import { isDefaultGitHubHost } from '../../shared/github-repository-identity-key'
import { isWslUncPath } from '../../shared/wsl-paths'
import { acquire, release } from './gh-utils'
import { ghExecFileAsync } from '../git/runner'
import {
  clearGhRateLimitBlock,
  getGhRateLimitBlockedUntilMs,
  ghRateLimitScopeKey,
  parseGhRateLimitScopeKey,
  recordGhPrimaryRateLimit,
  registerGhRateLimitResetProbe,
  type GhRateLimitBucket
} from '../git/gh-rate-limit-breaker'

// Why: GET /rate_limit is exempt from limits, so caching only avoids a gh subprocess per render; 30s stays live while absorbing 1/s polling.
const RATE_LIMIT_CACHE_TTL_MS = 30_000
let cached: GitHubRateLimitSnapshot | null = null
// Why: cache failures too — a host that 404s every probe (GHES with rate limiting off) would otherwise spawn a gh subprocess per refresh.
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
  // Why: absent bucket → 0/0/now so the UI reads "unknown" rather than a misleading "plenty left".
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
  scopeProbeFailureAtMs.clear()
  scopeRefinementInFlight.clear()
}

// Circuit-breaker floors: enough budget for one user flow; search paginates by 1, so 2 leaves a safety click under the 30/min cap.
const MIN_REMAINING_CORE = 50
const MIN_REMAINING_GRAPHQL = 50
const MIN_REMAINING_SEARCH = 2

export type RateLimitBucketKind = 'core' | 'graphql' | 'search'

/**
 * Return a "soft" stop reason if we should refuse a new gh request for the bucket; `{ blocked: false }` when there's budget or no snapshot yet (fail open).
 * Why: advisory (returns a reason, doesn't throw) so callers format the error envelope in their own shape.
 */
export function rateLimitGuard(bucket: RateLimitBucketKind):
  | { blocked: false }
  | {
      blocked: true
      remaining: number
      limit: number
      resetAt: number
    } {
  // Why: the breaker learns exhaustion from real 403s, which can precede a probe (e.g. quota burned by another tool on the account).
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
  // Why: a snapshot from before reset describes an ended window — fail open rather than block on stale data.
  if (b.resetAt * 1000 <= Date.now()) {
    return { blocked: false }
  }
  // Why: limit:0 means "unknown" (parseBucket fallback) — don't block on missing data or a single bad response bricks the app.
  if (b.limit > 0 && b.remaining < floor) {
    return { blocked: true, remaining: b.remaining, limit: b.limit, resetAt: b.resetAt }
  }
  return { blocked: false }
}

/**
 * Decrement the cached `remaining` for a bucket after a successful spawn.
 * Why: between probes the snapshot would over-report budget, so this keeps the breaker honest during a burst instead of waiting for the TTL.
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

// Why: this snapshot covers native github.com only; GHES and WSL use quotas protected by the runner's scoped breaker.
export function spendsSharedGitHubComQuota(
  repository: { host?: string } | null | undefined,
  executionOptions?: { wslDistro?: string; cwd?: string }
): boolean {
  if (!isDefaultGitHubHost(repository?.host) || executionOptions?.wslDistro) {
    return false
  }
  // Why: a \\wsl.localhost\... (or \\wsl$\...) cwd makes the runner spawn gh
  // inside WSL, so it spends that distro's quota. The UNC shape is
  // platform-unambiguous, so no win32 gate is needed.
  return !(executionOptions?.cwd && isWslUncPath(executionOptions.cwd))
}

export function repositoryRateLimitGuard(
  repository: { host?: string } | null | undefined,
  bucket: RateLimitBucketKind,
  executionOptions?: { wslDistro?: string; cwd?: string }
): ReturnType<typeof rateLimitGuard> {
  return spendsSharedGitHubComQuota(repository, executionOptions)
    ? rateLimitGuard(bucket)
    : { blocked: false }
}

export function noteRepositoryRateLimitSpend(
  repository: { host?: string } | null | undefined,
  bucket: RateLimitBucketKind,
  cost = 1,
  executionOptions?: { wslDistro?: string; cwd?: string }
): void {
  if (spendsSharedGitHubComQuota(repository, executionOptions)) {
    noteRateLimitSpend(bucket, cost)
  }
}

// Why: the breaker only knows "blocked", not the reset time; one exempt probe refines it to the real reset or clears a stale block (single-flight so a 403 burst probes once).
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

const DEFAULT_BREAKER_SCOPE = ghRateLimitScopeKey('native', 'github.com')
// Why: non-default scopes (GHES hosts, WSL runtimes) have their own quota and
// their own probe lifecycle — single-flight and failure negative-cache are
// keyed per scope so a GHES 403 storm can't starve a WSL refinement (or vice
// versa).
const scopeRefinementInFlight = new Map<string, Promise<void>>()
const scopeProbeFailureAtMs = new Map<string, number>()
const SCOPE_PROBE_FAILURE_MAX_ENTRIES = 512

function rememberScopeProbeFailure(scope: string, failedAt: number): void {
  for (const [key, at] of scopeProbeFailureAtMs) {
    if (failedAt - at >= RATE_LIMIT_CACHE_TTL_MS) {
      scopeProbeFailureAtMs.delete(key)
    }
  }
  scopeProbeFailureAtMs.delete(scope)
  scopeProbeFailureAtMs.set(scope, failedAt)
  while (scopeProbeFailureAtMs.size > SCOPE_PROBE_FAILURE_MAX_ENTRIES) {
    const oldestKey = scopeProbeFailureAtMs.keys().next().value
    if (oldestKey === undefined) {
      break
    }
    scopeProbeFailureAtMs.delete(oldestKey)
  }
}

function refineBreakerForScope(scope: string): void {
  // Default scope keeps the existing shared-snapshot refinement path.
  if (scope === DEFAULT_BREAKER_SCOPE) {
    refineBreakerFromSnapshot()
    return
  }
  const parts = parseGhRateLimitScopeKey(scope)
  if (!parts || scopeRefinementInFlight.has(scope)) {
    return
  }
  // Why: GHES with rate limiting disabled 404s every probe. Fail open (the
  // fallback block stands) and don't re-probe in a tight loop while the
  // breaker keeps tripping.
  const failedAt = scopeProbeFailureAtMs.get(scope)
  if (failedAt !== undefined && Date.now() - failedAt < RATE_LIMIT_CACHE_TTL_MS) {
    return
  }
  const probe = (async () => {
    try {
      await acquire()
      try {
        // Run the probe on the tripping scope's runtime/host so it describes
        // that account's buckets, not the native github.com ones.
        const { stdout } = await ghExecFileAsync(['api', 'rate_limit'], {
          encoding: 'utf-8',
          host: parts.host,
          ...(parts.runtime === 'wsl' ? { wslDistro: parts.wslDistro } : {})
        })
        const parsed = JSON.parse(stdout) as GhRateLimitPayload
        scopeProbeFailureAtMs.delete(scope)
        // Why: mirrors the default-scope refinement, but records into the
        // per-scope breaker only — the shared snapshot must keep describing
        // native github.com exclusively.
        for (const bucket of ['core', 'search', 'graphql'] as GhRateLimitBucket[]) {
          const b = parseBucket(parsed.resources?.[bucket])
          if (b.limit > 0 && b.remaining <= 0) {
            recordGhPrimaryRateLimit(bucket, b.resetAt * 1000, scope)
          } else if (b.limit > 0) {
            clearGhRateLimitBlock(bucket, scope)
          }
        }
      } finally {
        release()
      }
    } catch {
      // Why: GHES hosts can be supplied through pasted project URLs. Bound the
      // negative cache so repeated failing hosts cannot accumulate forever.
      rememberScopeProbeFailure(scope, Date.now())
    } finally {
      scopeRefinementInFlight.delete(scope)
    }
  })()
  scopeRefinementInFlight.set(scope, probe)
}

registerGhRateLimitResetProbe((_bucket, scope) => refineBreakerForScope(scope))

// Why: single-flight so a concurrent fan-out resolves to one probe — the TTL cache can't dedupe calls that start before the first lands.
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
    // Why: this singleton snapshot guards native github.com traffic. Pin the
    // host so a process-level GH_HOST cannot make it describe a GHES account.
    const { stdout } = await ghExecFileAsync(['api', 'rate_limit'], {
      encoding: 'utf-8',
      host: 'github.com'
    })
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
