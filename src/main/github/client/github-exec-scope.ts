import type { LocalGitExecOptions, OwnerRepo } from '../gh-utils'
import {
  hasHostedReviewLocalGitOptions,
  getHostedReviewLocalGitOptions
} from '../../source-control/hosted-review-git-options'
import type { HostedReviewExecutionOptions } from '../../source-control/hosted-review-git-options'
import type { GitHubRepoExecOptions } from '../github-api-repository'
import { githubRepoIdentityKey } from '../../../shared/github/repository-identity-key'
export type GhExecOptions = GitHubRepoExecOptions & { signal?: AbortSignal }

export type HostedReviewLocalGitOptions = ReturnType<typeof getHostedReviewLocalGitOptions>

export function hostedReviewLocalGitOptionArgs(
  options: HostedReviewExecutionOptions = {}
): [] | [HostedReviewLocalGitOptions] {
  return hasHostedReviewLocalGitOptions(options) ? [getHostedReviewLocalGitOptions(options)] : []
}

export function githubPRStackExecutionScope(
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): string {
  return connectionId ? `ssh:${connectionId}` : `local:${localGitOptions.wslDistro ?? 'host'}`
}

export function sameOwnerRepo(left: OwnerRepo | null, right: OwnerRepo | null): boolean {
  // Repository casing is insensitive; host identity still distinguishes equal slugs.
  return Boolean(left && right && githubRepoIdentityKey(left) === githubRepoIdentityKey(right))
}

export { ownerRepoFromPullRequestUrl } from '../../../shared/github/linked-pr-repository'
