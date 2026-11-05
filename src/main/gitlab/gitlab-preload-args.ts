import type { MRListState } from '../../shared/gitlab-types'

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

// RPC/SSH callers bypass renderer limits; bound search bytes at this boundary too.
const GITLAB_SEARCH_QUERY_MAX_BYTES = 2048

export function normalizeGitLabSearchQuery(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  if (!trimmed) {
    return undefined
  }
  return Buffer.byteLength(trimmed, 'utf8') > GITLAB_SEARCH_QUERY_MAX_BYTES ? undefined : trimmed
}

export function normalizeGitLabIssueAssignee(value: unknown): '@me' | undefined {
  // Accept only the renderer-supported assignment filter, not arbitrary CLI flags.
  return value === '@me' ? '@me' : undefined
}

export function normalizeGitLabIssueListArgs(args: {
  state?: unknown
  assignee?: unknown
  limit?: unknown
  page?: unknown
}): {
  state: GitLabIssueListState
  assignee: '@me' | undefined
  limit: number
  page: number
} {
  return {
    state: normalizeGitLabIssueListState(args.state),
    assignee: normalizeGitLabIssueAssignee(args.assignee),
    limit: normalizeGitLabPositiveInteger(args.limit, 20, 100),
    // GitLab pages are 1-based; the renderer translates its 0-based UI index.
    page: normalizeGitLabPositiveInteger(args.page, 1, 10_000)
  }
}
