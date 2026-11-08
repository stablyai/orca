import type { ExecutionHostId } from '../../../../src/shared/execution-host'
import type { Worktree } from '../../worktree/workspace-list-types'
import {
  getMobileWorkspaceLineageChildren,
  type MobileLineageRow,
  type MobileLineageStores
} from '../../worktree/mobile-workspace-lineage'
import { getWorktreeRowIdentity } from '../../worktree/worktree-host-row-identity'

/** What the folder list reads of a host row: lineage, then what a row shows. Agent and terminal fields churn, so they're left out. */
export type FolderListRow = MobileLineageRow &
  Pick<Worktree, 'repo' | 'displayName' | 'branch' | 'createdAt'>

export function toFolderListRow(row: Worktree): FolderListRow {
  return {
    worktreeId: row.worktreeId,
    hostId: row.hostId,
    repoId: row.repoId,
    workspaceKind: row.workspaceKind,
    isArchived: row.isArchived,
    parentWorktreeId: row.parentWorktreeId,
    worktreeInstanceId: row.worktreeInstanceId,
    lineageWorktreeInstanceId: row.lineageWorktreeInstanceId,
    parentWorktreeInstanceId: row.parentWorktreeInstanceId,
    crossStoreParent: row.crossStoreParent,
    workspaceLineage: row.workspaceLineage,
    repo: row.repo,
    displayName: row.displayName,
    branch: row.branch,
    createdAt: row.createdAt
  }
}

/** The folder workspace row a Source Control route names; a route without a server means the paired desktop's own. */
export function findFolderWorkspaceRow<Row extends FolderListRow>(
  rows: readonly Row[],
  folderWorktreeId: string,
  executionHost: ExecutionHostId | undefined
): Row | undefined {
  return rows.find(
    (row) =>
      row.worktreeId === folderWorktreeId &&
      row.workspaceKind === 'folder-workspace' &&
      (executionHost ? row.hostId === executionHost : !row.hostId?.startsWith('runtime:'))
  )
}

/** Worktrees attached to the folder, as the host list nests them, with their worktree descendants; oldest first, like desktop. */
export function getFolderAttachedWorktrees<Row extends FolderListRow>(
  rows: readonly Row[],
  folder: Row,
  stores?: MobileLineageStores
): Row[] {
  const childrenByParent = getMobileWorkspaceLineageChildren(rows, stores)
  const members = new Map<string, Row>()
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
