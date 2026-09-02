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
  // Why: casing does not distinguish GitHub repos, but the same slug on different hosts does.
  return Boolean(left && right && githubRepoIdentityKey(left) === githubRepoIdentityKey(right))
}

// Why: exact-linked fallback has no dataRepo; derive its host-aware identity from the web URL for merged-PR membership checks.
export function ownerRepoFromPullRequestUrl(url: string): OwnerRepo | null {
  const match = url.match(/^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pull\/\d+/)
  return match ? { owner: match[2], repo: match[3], host: match[1] } : null
}
