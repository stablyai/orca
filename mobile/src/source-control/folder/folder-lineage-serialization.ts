import type { Worktree } from '../../worktree/workspace-list/workspace-list-types'

/** The fields folder membership and order depend on; labels and agent state are left out so their churn rebuilds nothing. */
export function serializeFolderLineage(row: Worktree): string {
  return JSON.stringify([
    row.worktreeId,
    row.hostId,
    row.repoId,
    row.workspaceKind,
    row.isArchived,
    row.parentWorktreeId,
    row.worktreeInstanceId,
    row.lineageWorktreeInstanceId,
    row.parentWorktreeInstanceId,
    row.crossStoreParent,
    row.workspaceLineage,
    row.createdAt
  ])
}
