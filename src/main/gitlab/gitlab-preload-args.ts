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

// Why: cap the free-text MR search at the same byte budget the renderer
// enforces (SMART_WORKSPACE_SOURCE_QUERY_MAX_BYTES) so the RPC/SSH path —
// which can be driven by callers other than the desktop input — can't push
// an unbounded string into the glab `&search=` query.
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
  // Why: the renderer only exposes "Assigned to me"; accepting arbitrary
  // values would turn preload/RPC boundaries into a generic glab flag surface.
  return value === '@me' ? '@me' : undefined
}

export function normalizeGitLabIssueListArgs(args: {
  state?: unknown
  assignee?: unknown
  limit?: unknown
}): {
  state: GitLabIssueListState
  assignee: '@me' | undefined
  limit: number
} {
  return {
    state: normalizeGitLabIssueListState(args.state),
    assignee: normalizeGitLabIssueAssignee(args.assignee),
    limit: normalizeGitLabPositiveInteger(args.limit, 20, 100)
  }
}
