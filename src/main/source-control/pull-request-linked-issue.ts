import type { HostedReviewProvider } from '../../shared/source-control/hosted-review/hosted-review-contracts'
import type { PullRequestLinkedIssue } from '../../shared/source-control/ai/generation/pull-request-generation'
import { isLinkedIssueNumber } from '../../shared/source-control/ai/recipes/source-control-ai-action-variables'
import type { WorkspaceLinkedItem } from '../../shared/worktree/types'
import type { GitRuntimeOptions } from '../git/command-runner/git-runtime-options'
import { getIssue as getGitHubIssue } from '../github/issues/issues'

export type PullRequestLinkedIssueMeta = {
  linkedIssue?: number | null
  linkedGitLabIssue?: number | null
  linkedWorkItem?: WorkspaceLinkedItem | null
}

type LocalGitOptions = Pick<GitRuntimeOptions, 'wslDistro' | 'admissionTier'>
type LinkedIssueProvider = 'github' | 'gitlab' | 'gitea'

function inferIssueProvider(
  meta: PullRequestLinkedIssueMeta,
  provider?: HostedReviewProvider | null
): LinkedIssueProvider | null {
  if (provider === 'github' || provider === 'gitlab' || provider === 'gitea') {
    return provider
  }
  if (provider) {
    return null
  }
  if (meta.linkedWorkItem?.type === 'issue') {
    const linked = meta.linkedWorkItem.provider
    if (linked === 'github' || linked === 'gitlab' || linked === 'gitea') {
      return linked
    }
  }
  const hasGitHub = isLinkedIssueNumber(meta.linkedIssue)
  const hasGitLab = isLinkedIssueNumber(meta.linkedGitLabIssue)
  return hasGitHub === hasGitLab ? null : hasGitHub ? 'github' : 'gitlab'
}

function fallbackTitle(
  meta: PullRequestLinkedIssueMeta,
  provider: LinkedIssueProvider,
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
  // Gitea issues are linked only through the workspace's linked work item.
  const giteaItem = args.meta.linkedWorkItem
  const number =
    provider === 'github'
      ? args.meta.linkedIssue
      : provider === 'gitlab'
        ? args.meta.linkedGitLabIssue
        : giteaItem?.provider === 'gitea' && giteaItem.type === 'issue'
          ? giteaItem.number
          : null
  if (!provider || !isLinkedIssueNumber(number)) {
    return null
  }

  if (provider === 'gitea') {
    const { getGiteaIssue } = await import('../gitea/issues/gitea-issues')
    const issue = await getGiteaIssue(
      {
        repoPath: args.repoPath,
        connectionId: args.connectionId,
        localGitOptions: args.localGitOptions?.wslDistro
          ? { wslDistro: args.localGitOptions.wslDistro }
          : undefined
      },
      number
    ).catch(() => null)
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
      : await (
          await import('../gitlab/issues/gitlab-issue-queries')
        ).getIssue(args.repoPath, number, args.connectionId, args.localGitOptions)

  return {
    provider,
    number,
    title: issue?.title || fallbackTitle(args.meta, provider, number),
    description: issue?.description ?? ''
  }
}
