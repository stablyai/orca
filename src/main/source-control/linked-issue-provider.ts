import type { HostedReviewProvider } from '../../shared/source-control/hosted-review/hosted-review-contracts'
import { isLinkedIssueNumber } from '../../shared/source-control/ai/recipes/source-control-ai-action-variables'
import type { WorkspaceLinkedItem } from '../../shared/worktree/types'

export type PullRequestLinkedIssueMeta = {
  linkedIssue?: number | null
  linkedGitLabIssue?: number | null
  linkedWorkItem?: WorkspaceLinkedItem | null
}

export function inferIssueProvider(
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

/** The forge issue number {linkedIssue} expands to; null when none is linked or both forge slots tie. */
export function linkedIssueNumberForTemplate(
  meta: PullRequestLinkedIssueMeta | null | undefined,
  provider?: HostedReviewProvider | null
): number | null {
  if (!meta) {
    return null
  }
  const resolved = inferIssueProvider(meta, provider)
  const number =
    resolved === 'github' ? meta.linkedIssue : resolved === 'gitlab' ? meta.linkedGitLabIssue : null
  return isLinkedIssueNumber(number) ? number : null
}
