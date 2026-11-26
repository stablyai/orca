import type { ExecutionHostId } from '../../../../src/shared/execution-host/execution-host'
import type { Worktree as HostWorktree } from '../../../../src/shared/worktree/types'
import type { Worktree } from '../workspace-list/workspace-list-types'

// The row fields the shared resolver reads; the rest of a host record has no phone source.
export function asHostWorktree(row: Worktree, hostId: ExecutionHostId): HostWorktree {
  return {
    id: row.worktreeId,
    hostId,
    ...(row.worktreeInstanceId ? { instanceId: row.worktreeInstanceId } : {}),
    repoId: row.repoId,
    path: row.path,
    head: '',
    branch: row.branch,
    isBare: false,
    isMainWorktree: row.isMainWorktree ?? false,
    displayName: row.displayName,
    comment: row.comment ?? '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: row.isArchived === true,
    isUnread: row.unread,
    isPinned: row.isPinned,
    sortOrder: row.sortOrder ?? 0,
    lastActivityAt: row.lastActivityAt ?? 0,
    ...(row.createdAt !== undefined ? { createdAt: row.createdAt } : {})
  }
}
