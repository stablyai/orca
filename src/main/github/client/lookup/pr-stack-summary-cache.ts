import type { GitHubPRStack } from '../../../../shared/github/pull-request-types'
import type { ghRepoExecOptions } from '../../gh-utils'
import type { GitHubApiRepository } from '../../github-api-repository'
import { githubRepoIdentityKey } from '../../../../shared/github/repository-identity-key'
import { getRestPRByNumber } from './pr-number-lookup'
export const PR_STACK_SUMMARY_CACHE_TTL_MS = 60_000

// Why: a failed probe must not masquerade as "no stack" for a full minute; retry it sooner.
export const PR_STACK_SUMMARY_FAILURE_CACHE_TTL_MS = 5_000

export const PR_STACK_SUMMARY_CACHE_MAX_ENTRIES = 512

export const STACK_METADATA_UNAVAILABLE_ERROR =
  'Could not verify GitHub pull request stack metadata. Refresh and try again.'

type PRStackSummaryCacheEntry =
  | { ok: true; value: GitHubPRStack | undefined; expiresAt: number }
  | { ok: false; error: unknown; expiresAt: number }

export const prStackSummaryCache = new Map<string, PRStackSummaryCacheEntry>()

export const prStackSummaryInFlight = new Map<string, Promise<GitHubPRStack | undefined>>()

export function prunePRStackSummaryCache(now = Date.now()): void {
  for (const [key, cached] of prStackSummaryCache) {
    if (cached.expiresAt <= now) {
      prStackSummaryCache.delete(key)
    }
  }
  while (prStackSummaryCache.size > PR_STACK_SUMMARY_CACHE_MAX_ENTRIES) {
    const oldestKey = prStackSummaryCache.keys().next().value
    if (oldestKey === undefined) {
      return
    }
    prStackSummaryCache.delete(oldestKey)
  }
}

export async function getCachedGitHubPRStackSummary(
  ownerRepo: GitHubApiRepository,
  number: number,
  ghOptions: ReturnType<typeof ghRepoExecOptions>,
  executionScope: string
): Promise<GitHubPRStack | undefined> {
  const key = `${executionScope}\0${githubRepoIdentityKey(ownerRepo)}#${number}`
  const now = Date.now()
  prunePRStackSummaryCache(now)
  const cached = prStackSummaryCache.get(key)
  if (cached && cached.expiresAt > now) {
    // Why: a cached failure must stay a failure — returning undefined would read as "this PR has no stack".
    if (!cached.ok) {
      throw cached.error
    }
    return cached.value
  }
  const existing = prStackSummaryInFlight.get(key)
  if (existing) {
    return existing
  }
  const request = getRestPRByNumber(ownerRepo, number, ghOptions).then((pr) => pr.stack)
  prStackSummaryInFlight.set(key, request)
  try {
    const value = await request
    prStackSummaryCache.delete(key)
    prStackSummaryCache.set(key, {
      ok: true,
      value,
      expiresAt: Date.now() + PR_STACK_SUMMARY_CACHE_TTL_MS
    })
    prunePRStackSummaryCache()
    return value
  } catch (err) {
    // Why: avoid repeating a failed REST probe on every review poll, on a short cooldown.
    prStackSummaryCache.delete(key)
    prStackSummaryCache.set(key, {
      ok: false,
      error: err,
      expiresAt: Date.now() + PR_STACK_SUMMARY_FAILURE_CACHE_TTL_MS
    })
    prunePRStackSummaryCache()
    throw err
  } finally {
    if (prStackSummaryInFlight.get(key) === request) {
      prStackSummaryInFlight.delete(key)
    }
  }
}

export function _resetPRStackSummaryCacheForTests(): void {
  prStackSummaryCache.clear()
  prStackSummaryInFlight.clear()
}
