import type { HostedReviewProvider } from '../../shared/hosted-review'
import type { PullRequestLinkedIssue } from '../../shared/pull-request-generation'
import { isLinkedIssueNumber } from '../../shared/source-control-ai-action-variables'
import type { WorkspaceLinkedItem } from '../../shared/worktree/types'
import type { GitRuntimeOptions } from '../git/git-runtime-options'
import { getIssue as getGitHubIssue } from '../github/issues'
import { getGiteaIssue } from '../gitea/issues'
import { getIssue as getGitLabIssue } from '../gitlab/issues'

export type PullRequestLinkedIssueMeta = {
  linkedIssue?: number | null
  linkedGitLabIssue?: number | null
  linkedGiteaIssue?: number | null
  linkedWorkItem?: WorkspaceLinkedItem | null
}

type IssueProvider = 'github' | 'gitlab' | 'gitea'

type LocalGitOptions = Pick<GitRuntimeOptions, 'wslDistro' | 'admissionTier'>

function inferIssueProvider(
  meta: PullRequestLinkedIssueMeta,
  provider?: HostedReviewProvider | null
): IssueProvider | null {
  if (provider === 'github' || provider === 'gitlab' || provider === 'gitea') {
    return provider
  }
  if (provider) {
    return null
  }
  if (meta.linkedWorkItem?.type === 'issue') {
    const itemProvider = meta.linkedWorkItem.provider
    if (itemProvider === 'github' || itemProvider === 'gitlab' || itemProvider === 'gitea') {
      return itemProvider
    }
  }
  const present: IssueProvider[] = []
  if (isLinkedIssueNumber(meta.linkedIssue)) {
    present.push('github')
  }
  if (isLinkedIssueNumber(meta.linkedGitLabIssue)) {
    present.push('gitlab')
  }
  if (isLinkedIssueNumber(meta.linkedGiteaIssue)) {
    present.push('gitea')
  }
  return present.length === 1 ? present[0] : null
}

function fallbackTitle(
  meta: PullRequestLinkedIssueMeta,
  provider: IssueProvider,
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
        : provider === 'gitea'
          ? args.meta.linkedGiteaIssue
          : null
  if (!provider || !isLinkedIssueNumber(number)) {
    return null
  }

  if (provider === 'gitea') {
    const issue = await getGiteaIssue(
      args.repoPath,
      number,
      args.connectionId,
      args.localGitOptions
    )
    return {
      provider,
      number,
      title: issue?.title || fallbackTitle(args.meta, provider, number),
      description: issue?.body ?? ''
    }
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
