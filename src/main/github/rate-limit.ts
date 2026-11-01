// Breakers are host/runtime-scoped; bound accounts share a scope with ambient reset probes.
import type {
  GetRateLimitResult,
  GitHubRateLimitBucket,
  GitHubRateLimitSnapshot
} from '../../shared/github/rate-limit-types'
import { isDefaultGitHubHost } from '../../shared/github/repository-identity-key'
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

// GET /rate_limit is quota-exempt; caching avoids a subprocess per refresh.
const RATE_LIMIT_CACHE_TTL_MS = 30_000
let cached: GitHubRateLimitSnapshot | null = null
// Negative-cache failures, including Enterprise hosts with rate limiting disabled.
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
  // Missing buckets represent unknown budget, not available capacity.
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

/** Advisory failure envelope; absent snapshots fail open so callers can choose their own UI copy. */
export function rateLimitGuard(bucket: RateLimitBucketKind):
  | { blocked: false }
  | {
      blocked: true
      remaining: number
      limit: number
      resetAt: number
    } {
  // Real 403s can exhaust quota before any snapshot exists.
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
  // An expired budget window cannot justify blocking new work.
  if (b.resetAt * 1000 <= Date.now()) {
    return { blocked: false }
  }
  // limit 0 means unknown; malformed snapshots must not block the app.
  if (b.limit > 0 && b.remaining < floor) {
    return { blocked: true, remaining: b.remaining, limit: b.limit, resetAt: b.resetAt }
  }
  return { blocked: false }
}

/** Debit successful spawns between probes so bursts cannot overrun the cached budget. */
export function noteRateLimitSpend(bucket: RateLimitBucketKind, cost = 1): void {
  if (!cached) {
    return
  }
  const b = cached[bucket]
  if (b.remaining > 0) {
    cached = { ...cached, [bucket]: { ...b, remaining: Math.max(0, b.remaining - cost) } }
  }
}

// This snapshot covers native github.com only; Enterprise and WSL use scoped breakers.
export function spendsSharedGitHubComQuota(
  repository: { host?: string } | null | undefined,
  executionOptions?: { wslDistro?: string; cwd?: string }
): boolean {
  if (!isDefaultGitHubHost(repository?.host) || executionOptions?.wslDistro) {
    return false
  }
  // UNC cwd selects distro execution on every host; exclude its distinct quota.
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

// Share one exempt probe to refine reset time or clear an obsolete block after a 403 burst.
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
// Isolate probe lifetimes and failure cooldowns by host/runtime so one scope cannot starve another.
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
  if (scope === DEFAULT_BREAKER_SCOPE) {
    refineBreakerFromSnapshot()
    return
  }
  const parts = parseGhRateLimitScopeKey(scope)
  if (!parts || scopeRefinementInFlight.has(scope)) {
    return
  }
  // Failed refinement retains the fallback block; negative-cache disabled-limit Enterprise probes.
  const failedAt = scopeProbeFailureAtMs.get(scope)
  if (failedAt !== undefined && Date.now() - failedAt < RATE_LIMIT_CACHE_TTL_MS) {
    return
  }
  const probe = (async () => {
    try {
      await acquire()
      try {
        // Query the tripping runtime/host, independently of the shared native snapshot.
        const { stdout } = await ghExecFileAsync(['api', 'rate_limit'], {
          encoding: 'utf-8',
          host: parts.host,
          ...(parts.runtime === 'wsl' ? { wslDistro: parts.wslDistro } : {})
        })
        const parsed = JSON.parse(stdout) as GhRateLimitPayload
        scopeProbeFailureAtMs.delete(scope)
        // Refine only this scope's buckets; never overwrite the native github.com snapshot.
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
      // Pasted hosts are user-controlled; bound retained failures across them.
      rememberScopeProbeFailure(scope, Date.now())
    } finally {
      scopeRefinementInFlight.delete(scope)
    }
  })()
  scopeRefinementInFlight.set(scope, probe)
}

registerGhRateLimitResetProbe((_bucket, scope) => refineBreakerForScope(scope))

// Share cold probes; TTL caching cannot dedupe calls before the first result.
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
    // Pin the shared native snapshot against ambient GH_HOST redirection.
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
