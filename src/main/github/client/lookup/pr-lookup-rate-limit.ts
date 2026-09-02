import { ghRepoExecOptions, githubRepoContext, type LocalGitExecOptions } from '../../gh-utils'
import { getOriginGitHubApiRepository, type GitHubApiRepository } from '../../github-api-repository'
import {
  getRateLimit,
  repositoryRateLimitGuard,
  spendsSharedGitHubComQuota,
  type RateLimitBucketKind
} from '../../rate-limit'
import type { GhExecOptions } from './../github-exec-scope'
// Why: a branch lookup prefers REST but can fall back to `gh pr list` and
// `gh pr view`, so both buckets are guarded and charged. Mirrors the PR refresh
// coordinator's own estimate.
export const PR_BRANCH_LOOKUP_BUCKETS = ['core', 'graphql'] as const

/**
 * Rate-limit floor for GitHub PR lookups that do not run through the PR refresh
 * coordinator's queue (#11532).
 *
 * The coordinator guards and paces its own background refreshes, but
 * `hostedReview:forBranch` polls the same lookup straight from the renderer.
 * Ungated, the two paths together could spend the user's entire hourly quota —
 * which is per user and shared with their own `gh` and CLI agents.
 * Returns the reset time when the caller must not spend, else `null`.
 */
export async function getGitHubPRLookupRateLimitBlock(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<{ resetAt: number } | null> {
  const executionOptions = ghRepoExecOptions(
    githubRepoContext(repoPath, connectionId, localGitOptions)
  )
  // Why: identity resolution runs local git, which can fail for reasons that
  // have nothing to do with the budget; let the lookup itself classify those.
  const repository = await getOriginGitHubApiRepository(
    repoPath,
    connectionId,
    executionOptions
  ).catch(() => null)
  if (repository === null) {
    return null
  }
  if (spendsSharedGitHubComQuota(repository, executionOptions)) {
    // Why: the probe only warms the snapshot and is exempt from limits, so a
    // failure must fail open rather than block the lookup (#7553).
    await getRateLimit().catch(() => undefined)
  }
  // Why: retrying at the earlier reset would fail again on the bucket that has
  // not reset yet, so the latest blocked reset is the only honest retry time.
  const resets = PR_BRANCH_LOOKUP_BUCKETS.map((bucket) =>
    repositoryRateLimitGuard(repository, bucket, executionOptions)
  ).flatMap((guard) => (guard.blocked ? [guard.resetAt] : []))
  return resets.length > 0 ? { resetAt: Math.max(...resets) } : null
}

export async function assertRateLimitBudget(
  bucket: RateLimitBucketKind,
  repository?: GitHubApiRepository | null,
  executionOptions?: Pick<GhExecOptions, 'cwd' | 'wslDistro'>
): Promise<void> {
  if (spendsSharedGitHubComQuota(repository, executionOptions)) {
    await getRateLimit()
  }
  const guard = repositoryRateLimitGuard(repository, bucket, executionOptions)
  if (guard.blocked) {
    throw new Error(
      `GitHub ${bucket} rate limit is low; retry after ${new Date(guard.resetAt * 1000).toLocaleTimeString()}`
    )
  }
}
