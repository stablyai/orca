import { projectRowType } from './mobile-tasks-item-mapping'
import type {
  HostedReviewItem,
  HostedReviewMergeMethod,
  PendingHostedMerge,
  PendingHostedStateChange,
  PendingProjectGitHubMerge,
  TaskItem
} from './mobile-tasks-project-workspace-types'
import type {
  GitHubAssignableUser,
  GitHubPRReviewSummary,
  GitHubPRReviewerRow,
  GitHubWorkItem
} from './mobile-tasks-provider-detail-types'

export const LINEAR_PRIORITY_LABELS: Record<number, string> = {
  0: 'None',
  1: 'Urgent',
  2: 'High',
  3: 'Medium',
  4: 'Low'
}

export function getLinearPriorityLabel(priority: number): string {
  return LINEAR_PRIORITY_LABELS[priority] ?? `P${priority}`
}

export function getLinearPriorityRank(priority: number): number {
  return priority === 0 ? 5 : priority
}

export function formatGitHubReviewState(state: string | null | undefined): string {
  switch (state) {
    case 'APPROVED':
      return 'Approved'
    case 'CHANGES_REQUESTED':
      return 'Changes requested'
    case 'COMMENTED':
      return 'Commented'
    case 'DISMISSED':
      return 'Dismissed'
    case 'PENDING':
      return 'Pending'
    default:
      return 'Reviewed'
  }
}

export function getGitHubReviewerRows(item: {
  reviewRequests?: GitHubAssignableUser[]
  latestReviews?: GitHubPRReviewSummary[]
}): GitHubPRReviewerRow[] {
  const byLogin = new Map<string, GitHubPRReviewerRow>()
  for (const user of item.reviewRequests ?? []) {
    const login = user.login.trim()
    if (!login) {
      continue
    }
    byLogin.set(login.toLowerCase(), {
      login,
      name: user.name,
      avatarUrl: user.avatarUrl,
      stateLabel: 'Requested'
    })
  }
  for (const review of item.latestReviews ?? []) {
    const login = review.login.trim()
    const key = login.toLowerCase()
    if (!login || byLogin.has(key)) {
      continue
    }
    byLogin.set(key, {
      login,
      name: null,
      avatarUrl: review.avatarUrl,
      stateLabel: formatGitHubReviewState(review.state)
    })
  }
  return Array.from(byLogin.values())
}

export function getGitHubReviewSummary(item: {
  reviewDecision?: string | null
  reviewRequests?: GitHubAssignableUser[]
  latestReviews?: GitHubPRReviewSummary[]
}): string {
  if (item.reviewDecision === 'APPROVED') {
    return 'Approved'
  }
  if (item.reviewDecision === 'CHANGES_REQUESTED') {
    return 'Changes requested'
  }
  const rows = getGitHubReviewerRows(item)
  if (rows.length === 0) {
    return 'No reviewers'
  }
  if (rows.length === 1) {
    return `${rows[0]!.login} - ${rows[0]!.stateLabel}`
  }
  return `${rows[0]!.login} +${rows.length - 1}`
}

export function formatGitHubPRDelta(item: GitHubWorkItem): string | null {
  const parts: string[] = []
  if (typeof item.additions === 'number') {
    parts.push(`+${item.additions}`)
  }
  if (typeof item.deletions === 'number') {
    parts.push(`-${item.deletions}`)
  }
  if (typeof item.changedFiles === 'number') {
    parts.push(`${item.changedFiles} ${item.changedFiles === 1 ? 'file' : 'files'}`)
  }
  return parts.length > 0 ? parts.join(' ') : null
}

export function hostedBranchSummary(item: TaskItem): { head: string; base: string } | null {
  if (item.provider === 'github' && item.source.type === 'pr') {
    return {
      head: item.source.branchName?.trim() || 'unknown head',
      base: item.source.baseRefName?.trim() || 'base'
    }
  }
  if (item.provider === 'gitlab' && item.source.type === 'mr') {
    return {
      head: item.source.branchName?.trim() || 'unknown head',
      base: item.source.baseRefName?.trim() || 'base'
    }
  }
  return null
}

export function getGitHubMergeLabel(item: GitHubWorkItem): string {
  if (item.mergeable === undefined && item.mergeStateStatus === undefined) {
    return 'Merge'
  }
  if (item.state === 'merged') {
    return 'Merged'
  }
  if (item.state === 'closed') {
    return 'Closed'
  }
  if (item.mergeable === 'CONFLICTING') {
    return 'Conflicts'
  }
  if (item.mergeStateStatus === 'BEHIND') {
    return 'Behind'
  }
  if (item.mergeStateStatus === 'BLOCKED') {
    return 'Blocked'
  }
  if (item.mergeable === 'MERGEABLE' || item.mergeStateStatus === 'CLEAN') {
    return 'Able to merge'
  }
  return 'Unknown'
}

export function getHostedReviewMergeMethodLabel(method: HostedReviewMergeMethod): string {
  if (method === 'squash') {
    return 'Squash and merge'
  }
  if (method === 'rebase') {
    return 'Rebase and merge'
  }
  return 'Create merge commit'
}

export function hostedReviewMergeTargetLabel(item: HostedReviewItem): string {
  return item.provider === 'gitlab' ? 'merge request' : 'PR'
}

export function getHostedMergeConfirmMessage(pending: PendingHostedMerge): string {
  const target = hostedReviewMergeTargetLabel(pending.item)
  if (pending.method === 'squash') {
    return `Squash and merge ${target} #${pending.item.source.number}?`
  }
  const action = pending.method === 'rebase' ? 'Rebase and merge' : 'Merge'
  return `${action} ${target} #${pending.item.source.number}?`
}

export function getProjectGitHubMergeConfirmMessage(pending: PendingProjectGitHubMerge): string {
  const number = pending.row.content.number
  if (pending.method === 'squash') {
    return `Squash and merge PR #${number}?`
  }
  const action = pending.method === 'rebase' ? 'Rebase and merge' : 'Merge'
  return `${action} PR #${number}?`
}

export function hostedStateChangeAction(nextState: PendingHostedStateChange['nextState']): string {
  return nextState === 'closed' ? 'Close' : 'Reopen'
}

export function hostedStateChangeTarget(pending: PendingHostedStateChange): {
  titleTarget: string
  labelTarget: string
  number: number | null
} {
  if (pending.source === 'project') {
    const type = projectRowType(pending.row)
    return {
      titleTarget: type === 'pr' ? 'Pull Request' : 'Issue',
      labelTarget: type === 'pr' ? 'PR' : 'Issue',
      number: pending.row.content.number
    }
  }
  if (pending.item.provider === 'gitlab') {
    return {
      titleTarget: pending.item.source.type === 'mr' ? 'Merge Request' : 'Issue',
      labelTarget: pending.item.source.type === 'mr' ? 'MR' : 'Issue',
      number: pending.item.source.number
    }
  }
  return {
    titleTarget: pending.item.source.type === 'pr' ? 'Pull Request' : 'Issue',
    labelTarget: pending.item.source.type === 'pr' ? 'PR' : 'Issue',
    number: pending.item.source.number
  }
}

export function getHostedStateConfirmTitle(pending: PendingHostedStateChange): string {
  const target = hostedStateChangeTarget(pending)
  return `${hostedStateChangeAction(pending.nextState)} ${target.titleTarget}`
}

export function getHostedStateConfirmMessage(pending: PendingHostedStateChange): string {
  const target = hostedStateChangeTarget(pending)
  return `${hostedStateChangeAction(pending.nextState)} ${target.labelTarget} #${target.number}?`
}

export function getHostedStateConfirmLabel(pending: PendingHostedStateChange): string {
  const target = hostedStateChangeTarget(pending)
  return `${hostedStateChangeAction(pending.nextState)} ${target.labelTarget}`
}
