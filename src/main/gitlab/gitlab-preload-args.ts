import type { MRListState } from '../../shared/types'

export type GitLabIssueListState = 'opened' | 'closed' | 'all'

export function normalizeGitLabPositiveInteger(
  value: unknown,
  fallback: number,
  max: number
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }
  return Math.min(Math.max(1, Math.trunc(value)), max)
}

export function normalizeGitLabMRListState(value: unknown): MRListState {
  return value === 'merged' || value === 'closed' || value === 'all' ? value : 'opened'
}

export function normalizeGitLabIssueListState(value: unknown): GitLabIssueListState {
  return value === 'closed' || value === 'all' ? value : 'opened'
}

export function normalizeGitLabIssueAssignee(value: unknown): string | undefined {
  // Why: the issues panel exposes "Assigned to me" (`@me`), and the assignee
  // auto-start watcher filters by a configured GitLab username. Accept either,
  // but restrict free usernames to a conservative handle charset so this stays
  // a scoped filter rather than a generic glab flag surface.
  if (value === '@me') {
    return '@me'
  }
  if (typeof value === 'string') {
    const handle = value.trim().replace(/^@/, '')
    if (handle && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(handle)) {
      return handle
    }
  }
  return undefined
}

export function normalizeGitLabIssueListArgs(args: {
  state?: unknown
  assignee?: unknown
  limit?: unknown
}): {
  state: GitLabIssueListState
  assignee: string | undefined
  limit: number
} {
  return {
    state: normalizeGitLabIssueListState(args.state),
    assignee: normalizeGitLabIssueAssignee(args.assignee),
    limit: normalizeGitLabPositiveInteger(args.limit, 20, 100)
  }
}
