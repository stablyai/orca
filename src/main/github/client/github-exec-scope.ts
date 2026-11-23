import type { LocalGitExecOptions } from '../repositories/github-repository-identity'
import type { GitHubRepositoryIdentity as OwnerRepo } from '../../../shared/github/repositories/repository-identity'
import {
  hasHostedReviewLocalGitOptions,
  type getHostedReviewLocalGitOptions,
  resolveHostedReviewGitHubOptions,
  type HostedReviewExecutionOptions
} from '../../source-control/hosted-review-git-options'

import type { GitHubRepoExecOptions } from '../repositories/github-api-repository'
import { githubRepoIdentityKey } from '../../../shared/github/repositories/repository-identity-key'
import { codeHostReadExecutionScope as githubReadExecutionScope } from '../../source-control/code-host-read-execution-scope'
export type GhExecOptions = GitHubRepoExecOptions & { signal?: AbortSignal }

export type HostedReviewLocalGitOptions = ReturnType<typeof getHostedReviewLocalGitOptions>

export function hostedReviewLocalGitOptionArgs(
  options: HostedReviewExecutionOptions = {}
): [] | [HostedReviewLocalGitOptions] {
  return hasHostedReviewLocalGitOptions(options) ? [resolveHostedReviewGitHubOptions(options)] : []
}

export function githubPRStackExecutionScope(
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): string {
  const resolved = resolveHostedReviewGitHubOptions({ localGitExecOptions: localGitOptions })
  const hostScope = connectionId ? `ssh:${connectionId}` : `local:${resolved.wslDistro ?? 'host'}`
  return `${hostScope}\0${githubReadExecutionScope(resolved)}`
}

export function sameOwnerRepo(left: OwnerRepo | null, right: OwnerRepo | null): boolean {
  // Repository casing is insensitive; host identity still distinguishes equal slugs.
  return Boolean(left && right && githubRepoIdentityKey(left) === githubRepoIdentityKey(right))
}

// Exact-linked fallback has no dataRepo; use its URL for host-aware merged-commit membership.
export function ownerRepoFromPullRequestUrl(url: string): OwnerRepo | null {
  const match = url.match(/^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pull\/\d+/)
  return match ? { owner: match[2], repo: match[3], host: match[1] } : null
}
