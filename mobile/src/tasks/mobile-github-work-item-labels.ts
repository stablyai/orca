// Structural inputs on purpose: the Tasks screen carries its own narrower
// GitHub work-item shape, so binding these to src/shared/types would reject it.
export type GitHubPRReviewerRow = {
  login: string
  name?: string | null
  avatarUrl?: string | null
  stateLabel: string
}

type ReviewInput = {
  reviewDecision?: string | null
  reviewRequests?: readonly { login: string; name?: string | null; avatarUrl?: string | null }[]
  latestReviews?: readonly { login: string; state?: string | null; avatarUrl?: string | null }[]
}

type MergeStateInput = {
  state: string
  mergeable?: string | null
  mergeStateStatus?: string | null
}

type DiffStatInput = {
  additions?: number
  deletions?: number
  changedFiles?: number
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

// Requested reviewers win over submitted reviews for the same login so a pending
// re-request is not masked by that reviewer's earlier verdict.
export function getGitHubReviewerRows(item: ReviewInput): GitHubPRReviewerRow[] {
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

export function getGitHubReviewSummary(item: ReviewInput): string {
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

export function formatGitHubPRDelta(item: DiffStatInput): string | null {
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

export function getGitHubMergeLabel(item: MergeStateInput): string {
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
