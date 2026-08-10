import type { HostedReviewProvider } from '../../shared/hosted-review'
import type { PullRequestLinkedIssue } from '../../shared/pull-request-generation'
import { isLinkedIssueNumber } from '../../shared/source-control-ai-action-variables'
import type { WorkspaceLinkedItem } from '../../shared/types'
import { getIssue as getGitHubIssue } from '../github/issues'
import { getIssue as getGitLabIssue } from '../gitlab/issues'

export type PullRequestLinkedIssueMeta = {
  linkedIssue?: number | null
  linkedGitLabIssue?: number | null
  linkedWorkItem?: WorkspaceLinkedItem | null
}

type LocalGitOptions = { wslDistro?: string }

function inferIssueProvider(
  meta: PullRequestLinkedIssueMeta,
  provider?: HostedReviewProvider | null
): 'github' | 'gitlab' | null {
  if (provider === 'github' || provider === 'gitlab') {
    return provider
  }
  if (provider) {
    return null
  }
  if (meta.linkedWorkItem?.type === 'issue') {
    if (meta.linkedWorkItem.provider === 'github' || meta.linkedWorkItem.provider === 'gitlab') {
      return meta.linkedWorkItem.provider
    }
  }
  const hasGitHub = isLinkedIssueNumber(meta.linkedIssue)
  const hasGitLab = isLinkedIssueNumber(meta.linkedGitLabIssue)
  return hasGitHub === hasGitLab ? null : hasGitHub ? 'github' : 'gitlab'
}

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
