import type { HostedReviewProvider } from '../../shared/source-control/hosted-review/hosted-review-contracts'
import type { PullRequestLinkedIssue } from '../../shared/source-control/ai/generation/pull-request-generation'
import {
  inferIssueProvider,
  linkedIssueNumberForTemplate,
  type PullRequestLinkedIssueMeta
} from './linked-issue-provider'
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
  const number = linkedIssueNumberForTemplate(args.meta, args.provider)
  if (!provider || number === null) {
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
