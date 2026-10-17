import { ghExecFileAsync } from '../../gh-utils'
import { githubHostExecOptions, type GitHubApiRepository } from '../../github-api-repository'
import { noteRepositoryRateLimitSpend, repositoryRateLimitGuard } from '../../rate-limit'
import type { GhExecOptions } from '../github-exec-scope'

/** True when this pull request already has a merge-queue entry.
 *  `gh pr view` has no field for that, and enqueue does not set autoMergeRequest. */
export async function readPullRequestInMergeQueue(
  ownerRepo: GitHubApiRepository,
  prNumber: number,
  ghOptions: GhExecOptions
): Promise<boolean | undefined> {
  const guard = repositoryRateLimitGuard(ownerRepo, 'graphql', ghOptions)
  if (guard.blocked) {
    return undefined
  }
  const query = `query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) { isInMergeQueue }
    }
  }`
  try {
    noteRepositoryRateLimitSpend(ownerRepo, 'graphql', 1, ghOptions)
    const { stdout } = await ghExecFileAsync(
      [
        'api',
        'graphql',
        '-f',
        `query=${query}`,
        '-f',
        `owner=${ownerRepo.owner}`,
        '-f',
        `repo=${ownerRepo.repo}`,
        '-F',
        `number=${prNumber}`
      ],
      { ...ghOptions, ...githubHostExecOptions(ownerRepo) }
    )
    const parsed = JSON.parse(stdout) as {
      data?: { repository?: { pullRequest?: { isInMergeQueue?: unknown } | null } | null }
    }
    const value = parsed.data?.repository?.pullRequest?.isInMergeQueue
    return typeof value === 'boolean' ? value : undefined
  } catch {
    return undefined
  }
}
