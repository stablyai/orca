import { compareFolderWorkspacesForDisplay } from '../../../src/shared/sidebar-list/folder-workspace-lanes'
import type { Worktree } from './workspace-list-types'

function folderDisplayOrder(w: Worktree) {
  return {
    id: w.worktreeId,
    name: w.displayName,
    sortOrder: w.sortOrder ?? 0,
    manualOrder: w.manualOrder,
    executionHostId: w.hostId
  }
}

// Like desktop, a lane lists its folder workspaces after its worktrees, by user rank then name.
export function withFolderWorkspacesLast(worktrees: readonly Worktree[]): readonly Worktree[] {
  const rows: Worktree[] = []
  const folders: { row: Worktree; order: ReturnType<typeof folderDisplayOrder> }[] = []
  for (const row of worktrees) {
    if (row.workspaceKind === 'folder-workspace') {
      folders.push({ row, order: folderDisplayOrder(row) })
    } else {
      rows.push(row)
    }
  }
  if (folders.length === 0) {
    return worktrees
  }
  folders.sort((a, b) => compareFolderWorkspacesForDisplay(a.order, b.order))
  return [...rows, ...folders.map((folder) => folder.row)]
}
