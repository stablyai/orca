import type { HostedReviewInfo } from '../../shared/hosted-review'
import {
  ACTIVE_CLAIM_TTL_MS,
  ACTIVE_REFRESH_INTERVAL_MS,
  lookupBackoffDelayMs,
  LOOKUP_BACKOFF_MAX_MS,
  MAX_ACTIVE_BRANCHES,
  NO_REVIEW_REFRESH_INTERVAL_MS
} from './hosted-review-refresh-pacing'

/**
 * Process-wide cache for branch review lookups (#11532).
 *
 * `hostedReview:forBranch` is polled by every desktop window, the mobile client
 * and `orca serve` alike, and each one used to reach the provider directly. The
 * host's API quota is per user, so the only place that can pace them together is
 * here — the single funnel they all pass through.
 *
 * Pacing is tiered by what the user is looking at rather than applied flat: the
 * selected worktree is O(1) and can afford a per-minute re-check, while the
 * worktree list is O(N) and is what exhausts the budget.
 */

// Why: a found review still refreshes at the callers' poll cadence; the cache
// exists to collapse concurrent clients, not to make review state go stale.
const FOUND_REVIEW_TTL_MS = 60_000
const MAX_ENTRIES = 500

type CacheEntry = {
  review: HostedReviewInfo | null
  fetchedAt: number
  headOid: string | null
}

const entries = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<HostedReviewInfo | null>>()
const failureBackoff = new Map<string, { until: number; failures: number }>()
/** Branches a caller reported as its current selection, least recent first. */
const activeClaims = new Map<string, number>()
/** Bumped per repo on invalidation so a lookup that predates it cannot store. */
const scopeGenerations = new Map<string, number>()

// Why: NUL is the one byte a repo path or branch name cannot contain, so a
// scope prefix cannot straddle a component boundary — invalidating `/a/b` must
// not also flush the unrelated repo at `/a/b c`.
const KEY_SEPARATOR = '\0'

export type HostedReviewBranchCacheIdentity = {
  repoPath: string
  connectionId?: string | null
  branch: string
  linkedGitHubPR?: number | null
  fallbackGitHubPR?: number | null
  linkedGitLabMR?: number | null
  linkedBitbucketPR?: number | null
  linkedAzureDevOpsPR?: number | null
  linkedGiteaPR?: number | null
  localGitExecOptions?: unknown
}

export type HostedReviewBranchCacheOptions = {
  /** The worktree's checked-out HEAD oid, for merged-at-head visibility. */
  headOid: string | null
  /** Set by surfaces that only ever render the selected worktree. */
  active?: boolean
}

/** Repo-scoped prefix so a single repo's entries can be dropped without a full flush. */
function repoScope(repoPath: string, connectionId?: string | null): string {
  return `${connectionId ?? ''}${KEY_SEPARATOR}${repoPath}`
}

export function hostedReviewBranchCacheKey(identity: HostedReviewBranchCacheIdentity): string {
  return [
    repoScope(identity.repoPath, identity.connectionId),
    identity.branch,
    // Each linked id selects a different lookup, so it belongs in the identity.
    identity.linkedGitHubPR ?? '',
    identity.fallbackGitHubPR ?? '',
    identity.linkedGitLabMR ?? '',
    identity.linkedBitbucketPR ?? '',
    identity.linkedAzureDevOpsPR ?? '',
    identity.linkedGiteaPR ?? '',
    identity.localGitExecOptions ? JSON.stringify(identity.localGitExecOptions) : ''
  ].join(KEY_SEPARATOR)
}

/**
 * Records the caller's current selection, reporting whether the branch was not
 * already active. Claims are least-recently-used so the fast tier stays bounded
 * no matter how many a client asserts.
 */
function noteActiveClaim(key: string): boolean {
  const now = Date.now()
  for (const [candidate, claimedAt] of activeClaims) {
    if (now - claimedAt > ACTIVE_CLAIM_TTL_MS) {
      activeClaims.delete(candidate)
    }
  }
  const wasActive = activeClaims.has(key)
  activeClaims.delete(key)
  activeClaims.set(key, now)
  while (activeClaims.size > MAX_ACTIVE_BRANCHES) {
    const oldest = activeClaims.keys().next().value
    if (oldest === undefined) {
      break
    }
    activeClaims.delete(oldest)
  }
  return !wasActive
}

function isActiveBranch(key: string): boolean {
  const claimedAt = activeClaims.get(key)
  return claimedAt !== undefined && Date.now() - claimedAt <= ACTIVE_CLAIM_TTL_MS
}

// Why: a merged review is the one answer that depends on the inspected head —
// the merged-at-head carve-out keeps it visible only while the head matches.
// Negative answers are deliberately head-insensitive, so a branch under active
// commits cannot defeat the long no-review interval.
function isHeadSensitive(entry: CacheEntry): boolean {
  return entry.review?.state === 'merged'
}

function refreshIntervalMs(entry: CacheEntry, active: boolean): number {
  if (entry.review !== null) {
    return FOUND_REVIEW_TTL_MS
  }
  return active ? ACTIVE_REFRESH_INTERVAL_MS : NO_REVIEW_REFRESH_INTERVAL_MS
}

function isFresh(entry: CacheEntry, headOid: string | null, active: boolean): boolean {
  if (isHeadSensitive(entry) && headOid !== null && entry.headOid !== null) {
    if (headOid !== entry.headOid) {
      return false
    }
  }
  return Date.now() - entry.fetchedAt < refreshIntervalMs(entry, active)
}

function storeEntry(key: string, entry: CacheEntry): void {
  entries.delete(key)
  entries.set(key, entry)
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value
    if (oldest === undefined) {
      break
    }
    entries.delete(oldest)
  }
}

function backoffUntil(key: string): number | null {
  // Why: a lapsed window keeps its failure count, otherwise the very act of
  // retrying resets the escalation and the backoff never grows past the base.
  const entry = failureBackoff.get(key)
  return entry !== undefined && entry.until > Date.now() ? entry.until : null
}

function noteFailure(key: string): void {
  const now = Date.now()
  for (const [candidate, entry] of failureBackoff) {
    // Why: only counts that lapsed a full max window ago are stale enough to
    // forget; anything more eager would undo the escalation above.
    if (now - entry.until > LOOKUP_BACKOFF_MAX_MS) {
      failureBackoff.delete(candidate)
    }
  }
  const failures = (failureBackoff.get(key)?.failures ?? 0) + 1
  failureBackoff.delete(key)
  failureBackoff.set(key, { until: now + lookupBackoffDelayMs(failures), failures })
  while (failureBackoff.size > MAX_ENTRIES) {
    const oldest = failureBackoff.keys().next().value
    if (oldest === undefined) {
      break
    }
    failureBackoff.delete(oldest)
  }
}

function scopeGeneration(scope: string): number {
  return scopeGenerations.get(scope) ?? 0
}

function bumpScopeGeneration(scope: string): void {
  const next = scopeGeneration(scope) + 1
  scopeGenerations.delete(scope)
  scopeGenerations.set(scope, next)
  // Why: an evicted scope reads as generation 0, which only makes a lookup in
  // flight at eviction discard its result — a wasted call, never a stale one.
  while (scopeGenerations.size > MAX_ENTRIES) {
    const oldest = scopeGenerations.keys().next().value
    if (oldest === undefined) {
      break
    }
    scopeGenerations.delete(oldest)
  }
}

/**
 * Drops every cached answer for a repo. Called when Orca itself opens a review,
 * so the new one is visible immediately instead of after the no-review interval.
 */
export function invalidateHostedReviewBranchCache(
  repoPath: string,
  connectionId?: string | null
): void {
  const scope = repoScope(repoPath, connectionId)
  bumpScopeGeneration(scope)
  const prefix = `${scope}${KEY_SEPARATOR}`
  for (const key of entries.keys()) {
    if (key.startsWith(prefix)) {
      entries.delete(key)
    }
  }
  for (const key of failureBackoff.keys()) {
    if (key.startsWith(prefix)) {
      failureBackoff.delete(key)
    }
  }
}

/** @internal - exposed for tests only */
export function __resetHostedReviewBranchCacheForTests(): void {
  entries.clear()
  inflight.clear()
  failureBackoff.clear()
  activeClaims.clear()
  scopeGenerations.clear()
}

/**
 * Serves `lookup` through the shared cache: a fresh answer is reused, concurrent
 * callers share one in-flight lookup, and a failing branch backs off instead of
 * being re-asked at every caller's poll cadence.
 */
export async function withHostedReviewBranchCache(
  identity: HostedReviewBranchCacheIdentity,
  options: HostedReviewBranchCacheOptions,
  lookup: () => Promise<HostedReviewInfo | null>
): Promise<HostedReviewInfo | null> {
  const key = hostedReviewBranchCacheKey(identity)
  const headOid = options.headOid
  if (options.active === true && noteActiveClaim(key) && entries.get(key)?.review === null) {
    // Why: switching to a worktree is the user asking whether a review exists
    // yet, so the long no-review interval must not answer on their behalf. This
    // is the cheap half of the fast tier — it costs one lookup per selection
    // rather than one per minute.
    entries.delete(key)
  }
  const active = isActiveBranch(key)

  const cached = entries.get(key)
  if (cached && isFresh(cached, headOid, active)) {
    return cached.review
  }

  const pending = inflight.get(key)
  if (pending) {
    return pending
  }

  const until = backoffUntil(key)
  if (until !== null) {
    // Why: a stale answer beats an error card, but with nothing cached the
    // caller must hear the failure rather than read it as "no review".
    if (cached) {
      return cached.review
    }
    throw new Error(
      `Hosted review lookup is backing off after repeated failures. Retrying after ${new Date(
        until
      ).toLocaleTimeString()}.`
    )
  }

  const scope = repoScope(identity.repoPath, identity.connectionId)
  const request = (async () => {
    const generation = scopeGeneration(scope)
    try {
      const review = await lookup()
      // Why: a review created while this lookup was out makes its answer older
      // than the invalidation; storing it would re-pin the stale "no review".
      if (generation === scopeGeneration(scope)) {
        storeEntry(key, { review, fetchedAt: Date.now(), headOid })
        failureBackoff.delete(key)
      }
      return review
    } catch (error) {
      noteFailure(key)
      // Why: the last good review beats an error card here just as it does on
      // the backed-off path — otherwise it blinks out on the first failure.
      // An invalidation drops the entry, so this cannot revive a retired answer.
      const stale = entries.get(key)
      if (stale) {
        return stale.review
      }
      throw error
    } finally {
      inflight.delete(key)
    }
  })()
  inflight.set(key, request)
  return request
}
