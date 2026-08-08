import type { GitHubPrStartPoint, GitPushTarget } from '../../shared/types'
import { getOptionalPositiveIntegerFlag, getOptionalStringFlag } from '../flags'
import type { RuntimeClient } from '../runtime-client'
import { RuntimeClientError } from '../runtime-client'

type GitHubPullRequestCreateLink = {
  baseBranch?: string
  compareBaseRef?: string
  branchNameOverride?: string
  pushTarget?: GitPushTarget
  linkedPR?: number
}

export async function resolveGitHubPullRequestCreateLink(
  flags: Map<string, string | boolean>,
  repo: string,
  client: RuntimeClient
): Promise<GitHubPullRequestCreateLink> {
  const rawPullRequest = flags.get('pull-request')
  if (flags.has('pull-request') && (typeof rawPullRequest !== 'string' || rawPullRequest === '')) {
    throw new RuntimeClientError('invalid_argument', 'Missing value for --pull-request.')
  }
  const linkedPR = getOptionalPositiveIntegerFlag(flags, 'pull-request')
  if (linkedPR === undefined) {
    return { baseBranch: getOptionalStringFlag(flags, 'base-branch') }
  }
  if (flags.has('base-branch')) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Choose either --pull-request or --base-branch, not both.'
    )
  }
  const response = await client.call<GitHubPrStartPoint | { error: string }>(
    'worktree.resolvePrBase',
    {
      repo,
      prNumber: linkedPR
    }
  )
  if ('error' in response.result) {
    throw new RuntimeClientError('runtime_error', response.result.error)
  }
  if (typeof response.result.baseBranch !== 'string' || response.result.baseBranch.length === 0) {
    throw new RuntimeClientError(
      'runtime_error',
      'Pull request start point is missing a base branch.'
    )
  }
  return {
    baseBranch: response.result.baseBranch,
    compareBaseRef: response.result.compareBaseRef,
    branchNameOverride: response.result.branchNameOverride,
    pushTarget: response.result.pushTarget,
    linkedPR
  }
}
