import { ghRepoExecOptions, githubRepoContext, type LocalGitExecOptions } from '../../gh-utils'
import { getOriginGitHubApiRepository, type GitHubApiRepository } from '../../github-api-repository'
import {
  getRateLimit,
  repositoryRateLimitGuard,
  spendsSharedGitHubComQuota,
  type RateLimitBucketKind
} from '../../rate-limit'
import type { GhExecOptions } from './../github-exec-scope'
// REST branch lookup can fall back to GraphQL-backed gh commands; guard and debit both buckets.
export const PR_BRANCH_LOOKUP_BUCKETS = ['core', 'graphql'] as const

/** Guard direct renderer lookups as well as coordinator work; return the latest blocked reset or null. */
export async function getGitHubPRLookupRateLimitBlock(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<{ resetAt: number } | null> {
  const executionOptions = ghRepoExecOptions(
    githubRepoContext(repoPath, connectionId, localGitOptions)
  )
  // Identity-probe failures belong to lookup classification, not budget gating.
  const repository = await getOriginGitHubApiRepository(
    repoPath,
    connectionId,
    executionOptions
  ).catch(() => null)
  if (repository === null) {
    return null
  }
  if (spendsSharedGitHubComQuota(repository, executionOptions)) {
    // Exempt budget-probe failures must not block otherwise usable lookups.
    await getRateLimit().catch(() => undefined)
  }
  // Retrying before every blocked bucket resets would immediately fail again.
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
