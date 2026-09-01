import type { GitHubPRRefreshCandidate } from '../../shared/github/pull-request-refresh-types'
import { getOriginGitHubApiRepository } from './github-api-repository'
import { ghRepoExecOptions, githubRepoContext } from './gh-utils'
import { getRateLimit, repositoryRateLimitGuard, spendsSharedGitHubComQuota } from './rate-limit'

const BUCKETS = ['core', 'graphql'] as const

export async function prRefreshRateLimitPausedUntil(
  candidate: GitHubPRRefreshCandidate,
  warmSharedSnapshot: boolean
): Promise<number | null> {
  const executionOptions = ghRepoExecOptions(
    githubRepoContext(candidate.repoPath, candidate.connectionId, candidate.localGitOptions)
  )
  const repository = await getOriginGitHubApiRepository(
    candidate.repoPath,
    candidate.connectionId,
    executionOptions
  )
  if (warmSharedSnapshot && spendsSharedGitHubComQuota(repository, executionOptions)) {
    await getRateLimit()
  }
  const blockedGuard = BUCKETS.map((bucket) =>
    repositoryRateLimitGuard(repository, bucket, executionOptions)
  ).find((guard) => guard.blocked)
  return blockedGuard?.blocked ? blockedGuard.resetAt * 1000 : null
}
