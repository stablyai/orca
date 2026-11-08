import type { ExecutionHostId } from '../../../../src/shared/execution-host'
import type { Worktree } from '../../worktree/workspace-list-types'
import {
  getMobileWorkspaceLineageChildren,
  type MobileLineageStores
} from '../../worktree/mobile-workspace-lineage'
import { getWorktreeRowIdentity } from '../../worktree/worktree-host-row-identity'

/** The folder workspace row a Source Control route names; a route without a server means the paired desktop's own. */
export function findFolderWorkspaceRow(
  rows: readonly Worktree[],
  folderWorktreeId: string,
  executionHost: ExecutionHostId | undefined
): Worktree | undefined {
  return rows.find(
    (row) =>
      row.worktreeId === folderWorktreeId &&
      row.workspaceKind === 'folder-workspace' &&
      (executionHost ? row.hostId === executionHost : !row.hostId?.startsWith('runtime:'))
  )
}

/** Worktrees attached to the folder, as the host list nests them, with their worktree descendants; oldest first, like desktop. */
export function getFolderAttachedWorktrees(
  rows: readonly Worktree[],
  folder: Worktree,
  stores?: MobileLineageStores
): Worktree[] {
  const childrenByParent = getMobileWorkspaceLineageChildren(rows, stores)
  const members = new Map<string, Worktree>()
  const queue = [folder]
  for (let i = 0; i < queue.length; i++) {
    for (const child of childrenByParent.get(getWorktreeRowIdentity(queue[i])) ?? []) {
      const identity = getWorktreeRowIdentity(child)
      if (child.isArchived || members.has(identity)) {
        continue
      }
      members.set(identity, child)
      queue.push(child)
    }
  }
  // Rows carry no attach time; a child is attached when it is created from the folder.
  return [...members.values()].sort(
    (left, right) =>
      (left.createdAt ?? 0) - (right.createdAt ?? 0) ||
      getWorktreeRowIdentity(left).localeCompare(getWorktreeRowIdentity(right))
  )
}
