import type { ExecutionHostId } from '../../shared/execution-host'
import type { HostedReviewForBranchOutcome, HostedReviewInfo } from '../../shared/hosted-review'
import { cachedHostedReviewOutcome } from '../../shared/hosted-review'
import {
  __resetHostedReviewActiveClaimsForTests,
  isActiveBranch,
  noteActiveClaim
} from './hosted-review-active-branch-claims'
import {
  __resetUnsettledHostedReviewLookupsForTests,
  lookupCapacityRefusal,
  noteDetachedLookup,
  noteLookupStarted,
  settleDetachedLookup,
  settleLookup
} from './hosted-review-unsettled-lookups'
import {
  __resetHostedReviewInflightLookupsForTests,
  expireOverdueInflight,
  getInflightLookup,
  releaseInflight,
  retireInflightWithPrefix,
  retireInflightLookup,
  trackInflight,
  type InflightToken
} from './hosted-review-inflight-lookups'
import {
  __resetHostedReviewScopeGenerationsForTests,
  bumpScopeGeneration,
  hostedReviewRepoScope,
  scopeGeneration
} from './hosted-review-scope-generations'
import {
  __resetHostedReviewLookupBackoffForTests,
  backoffUntil,
  clearFailures,
  dropFailuresWithPrefix,
  noteFailure
} from './hosted-review-lookup-backoff'
import { observeProviderRead } from './hosted-review-provider-read'
import {
  ACTIVE_REFRESH_INTERVAL_MS,
  HOSTED_REVIEW_LOOKUP_DEADLINE_MS,
  MAX_BRANCH_MAP_ENTRIES,
  NO_REVIEW_REFRESH_INTERVAL_MS
} from './hosted-review-refresh-pacing'

/** All desktop/mobile/serve callers share this host's API quota. Pace active selection separately from the O(N) worktree list (#11532). */

// Collapse clients without making found reviews lag their polling cadence.
const FOUND_REVIEW_TTL_MS = 60_000
const MAX_ENTRIES = MAX_BRANCH_MAP_ENTRIES

type CacheEntry = {
  review: HostedReviewInfo | null
  fetchedAt: number
  headOid: string | null
  /** When the lookup that produced this answer began, for straggler ordering. */
  startedAt: number
}

const entries = new Map<string, CacheEntry>()
// NUL cannot occur in paths/branches, preventing invalidation prefixes from crossing identity components.
const KEY_SEPARATOR = '\0'

export type HostedReviewBranchCacheIdentity = {
  repoPath: string
  executionHostId: ExecutionHostId
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
  force?: boolean
  userRefresh?: boolean
}

export function hostedReviewBranchCacheKey(identity: HostedReviewBranchCacheIdentity): string {
  return [
    hostedReviewRepoScope(identity.repoPath, identity.executionHostId),
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

// Only merged visibility depends on HEAD; commits must not defeat negative-cache pacing.
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

/** Invalidate after review creation so long negative-cache intervals cannot hide the new review. */
export function invalidateHostedReviewBranchCache(
  repoPath: string,
  executionHostId: ExecutionHostId
): void {
  const scope = hostedReviewRepoScope(repoPath, executionHostId)
  bumpScopeGeneration(scope)
  const prefix = `${scope}${KEY_SEPARATOR}`
  for (const key of entries.keys()) {
    if (key.startsWith(prefix)) {
      entries.delete(key)
    }
  }
  retireInflightWithPrefix(prefix)
  dropFailuresWithPrefix(prefix)
}

/** @internal - exposed for tests only */
export function __resetHostedReviewBranchCacheForTests(): void {
  entries.clear()
  __resetHostedReviewInflightLookupsForTests()
  __resetHostedReviewLookupBackoffForTests()
  __resetHostedReviewActiveClaimsForTests()
  __resetUnsettledHostedReviewLookupsForTests()
  __resetHostedReviewScopeGenerationsForTests()
}

/** Detached answers may fill gaps or replace strictly older attempts only; never outrank the served pre-refresh answer or a replacement owner. Late null would otherwise mask a real review. */
function canAdoptDetachedAnswer(key: string, startedAt: number): boolean {
  if (getInflightLookup(key) !== undefined) {
    return false
  }
  const current = entries.get(key)
  return current === undefined || (current.startedAt < startedAt && current.fetchedAt >= startedAt)
}

function lookupUnavailableReason(key: string): string | null {
  const until = backoffUntil(key)
  if (until !== null) {
    return `Hosted review lookup is backing off after repeated failures. Retrying after ${new Date(
      until
    ).toLocaleTimeString()}.`
  }
  return lookupCapacityRefusal(key)
}

/** Deadline detaches uninterruptible work and releases callers; adopt a later answer only if still current so a host can recover in-session (P1-D). */
function startLookup(
  key: string,
  scope: string,
  headOid: string | null,
  revisionScope: string,
  lookup: () => Promise<HostedReviewInfo | null>
): Promise<HostedReviewForBranchOutcome> {
  const startedAt = Date.now()
  const generation = scopeGeneration(scope)
  const revision = scopeGeneration(revisionScope)
  const token: InflightToken = {}
  let timedOut = false
  let completed = false
  let release: (read: HostedReviewForBranchOutcome) => void = () => {}
  let fail: (error: unknown) => void = () => {}
  const promise = new Promise<HostedReviewForBranchOutcome>((resolve, reject) => {
    release = resolve
    fail = reject
  })
  let timer: ReturnType<typeof setTimeout> | undefined

  const expire = (): void => {
    if (timedOut || completed) {
      return
    }
    timedOut = true
    if (timer !== undefined) {
      clearTimeout(timer)
    }
    // Only current ownership may shape backoff; a straggler must not penalize its running successor.
    if (releaseInflight(key, token)) {
      noteFailure(key)
    }
    // Detached work remains uninterruptible; count it process-wide until completion.
    noteDetachedLookup()
    fail(
      new Error(
        `Hosted review lookup timed out after ${Math.round(
          HOSTED_REVIEW_LOOKUP_DEADLINE_MS / 1000
        )}s. It will be retried on a later poll.`
      )
    )
  }

  // Reserve when starting, not at deadline: an entire first wave could wedge before then.
  noteLookupStarted(key)
  timer = setTimeout(expire, HOSTED_REVIEW_LOOKUP_DEADLINE_MS)
  if (typeof timer === 'object' && 'unref' in timer) {
    timer.unref()
  }
  // Register before invoking so synchronous throws cannot leave a pinned record.
  trackInflight(key, { token, startedAt, promise, expire })

  void (async () => {
    try {
      const { value: review, answeredFromProviderCache } = await observeProviderRead(lookup)
      // Generation invalidates pre-creation answers; without key ownership, stragglers must prove their result still outranks the cache.
      const stored =
        generation === scopeGeneration(scope) &&
        revision === scopeGeneration(revisionScope) &&
        (getInflightLookup(key)?.token === token || canAdoptDetachedAnswer(key, startedAt))
      if (stored) {
        storeEntry(key, { review, fetchedAt: Date.now(), headOid, startedAt })
      }
      // Only on-time answers prove health; clearing failures on late data would prevent escalation.
      if (stored && !timedOut) {
        clearFailures(key)
      }
      release({ review, readOutcome: stored && !answeredFromProviderCache ? 'provider' : 'cached' })
    } catch (error) {
      // Deadline already counted failure; never count late rejection twice.
      if (timedOut) {
        return
      }
      // Size-evicted stragglers must not back off their successor's branch.
      if (getInflightLookup(key)?.token === token) {
        noteFailure(key)
      }
      fail(error)
    } finally {
      completed = true
      if (timer !== undefined) {
        clearTimeout(timer)
      }
      if (timedOut) {
        settleDetachedLookup()
      }
      settleLookup(key)
      releaseInflight(key, token)
    }
  })()

  return promise
}

export async function withHostedReviewBranchCache(
  ...args: Parameters<typeof readHostedReviewBranchCache>
): Promise<HostedReviewInfo | null> {
  return (await readHostedReviewBranchCache(...args)).review
}

/** Share fresh answers/in-flight lookups across clients and back off failed branches. */
export async function readHostedReviewBranchCache(
  identity: HostedReviewBranchCacheIdentity,
  options: HostedReviewBranchCacheOptions,
  lookup: () => Promise<HostedReviewInfo | null>
): Promise<HostedReviewForBranchOutcome> {
  const key = hostedReviewBranchCacheKey(identity)
  const headOid = options.headOid
  // Sweep wall-clock deadlines before joining so suspended timers cannot pin a branch after sleep.
  expireOverdueInflight(Date.now())
  if (options.active === true && noteActiveClaim(key) && entries.get(key)?.review === null) {
    // Selection asks again immediately rather than waiting out the long negative cache.
    entries.delete(key)
  }
  const active = isActiveBranch(key)

  const cached = entries.get(key)
  if (!options.userRefresh && !options.force && cached && isFresh(cached, headOid, active)) {
    return cachedHostedReviewOutcome(cached.review)
  }

  // Admission is keyed independently of revision; a refused click cannot retire an admitted owner.
  const unavailable = options.userRefresh ? lookupCapacityRefusal(key) : null
  if (unavailable !== null) {
    throw new Error(unavailable)
  }
  const revisionScope = `branch-refresh${KEY_SEPARATOR}${key}`
  if (options.userRefresh) {
    bumpScopeGeneration(revisionScope)
    retireInflightLookup(key)
  }

  const settleForCaller = async (promise: Promise<HostedReviewForBranchOutcome>) => {
    try {
      return await promise
    } catch (error) {
      const stale = entries.get(key)
      if (!options.userRefresh && stale) {
        return cachedHostedReviewOutcome(stale.review)
      }
      throw error
    }
  }
  const pending = getInflightLookup(key)
  if (pending) {
    // The owner began before this caller asked, so its answer can't prove a read after this caller's failure.
    return settleForCaller(pending.promise.then(({ review }) => cachedHostedReviewOutcome(review)))
  }

  const refusal = options.userRefresh ? null : lookupUnavailableReason(key)
  if (refusal !== null) {
    if (cached) {
      return cachedHostedReviewOutcome(cached.review)
    }
    throw new Error(refusal)
  }

  return settleForCaller(
    startLookup(
      key,
      hostedReviewRepoScope(identity.repoPath, identity.executionHostId),
      headOid,
      revisionScope,
      lookup
    )
  )
}
