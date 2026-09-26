import type { HostedReviewProvider } from '../../shared/hosted-review'
import {
  inferIssueProvider,
  type PullRequestLinkedIssueMeta
} from '../../shared/linked-issue-provider'
import type { PullRequestLinkedIssue } from '../../shared/pull-request-generation'
import { isLinkedIssueNumber } from '../../shared/source-control-ai-action-variables'
import type { GitRuntimeOptions } from '../git/git-runtime-options'
import { getIssue as getGitHubIssue } from '../github/issues'
import { getIssue as getGitLabIssue } from '../gitlab/issues'

type LocalGitOptions = Pick<GitRuntimeOptions, 'wslDistro' | 'admissionTier'>

function fallbackTitle(
  meta: PullRequestLinkedIssueMeta,
  provider: 'github' | 'gitlab',
  number: number
): string {
  const item = meta.linkedWorkItem
  return item?.provider === provider && item.type === 'issue' && item.number === number
    ? item.title
    : '(title unavailable)'
}

export async function loadPullRequestLinkedIssue(args: {
  meta: PullRequestLinkedIssueMeta | null | undefined
  provider?: HostedReviewProvider | null
  repoPath: string
  connectionId?: string | null
  localGitOptions?: LocalGitOptions
}): Promise<PullRequestLinkedIssue | null> {
  if (!args.meta) {
    return null
  }
  const provider = inferIssueProvider(args.meta, args.provider)
  const number =
    provider === 'github'
      ? args.meta.linkedIssue
      : provider === 'gitlab'
        ? args.meta.linkedGitLabIssue
        : null
  if (!provider || !isLinkedIssueNumber(number)) {
    return null
  }

  const issue =
    provider === 'github'
      ? await getGitHubIssue(args.repoPath, number, args.connectionId, args.localGitOptions)
      : await getGitLabIssue(args.repoPath, number, args.connectionId, args.localGitOptions)

  return {
    provider,
    number,
    title: issue?.title || fallbackTitle(args.meta, provider, number),
    description: issue?.description ?? ''
  }
}
