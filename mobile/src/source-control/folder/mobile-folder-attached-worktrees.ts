import type { ExecutionHostId } from '../../../../src/shared/execution-host'
import type { Worktree } from '../../worktree/workspace-list-types'
import {
  getMobileWorkspaceLineageChildren,
  type MobileLineageRow,
  type MobileLineageStores
} from '../../worktree/mobile-workspace-lineage'
import { getWorktreeRowIdentity } from '../../worktree/worktree-host-row-identity'
import { serializeFolderLineage } from './folder-lineage-serialization'

/** What a folder list row shows of a host row. */
export type FolderListRow = Pick<
  Worktree,
  'worktreeId' | 'hostId' | 'repo' | 'displayName' | 'branch'
>

type FolderLineageRow = MobileLineageRow & Pick<Worktree, 'createdAt'>

// Keyed by row object: the catalog query keeps an unchanged row's identity, so only changed rows are read again.
const lineageKeys = new WeakMap<Worktree, string>()
const listRows = new WeakMap<Worktree, FolderListRow>()

/** A row's lineage key, serialized once per row object. */
export function folderLineageKey(row: Worktree): string {
  let key = lineageKeys.get(row)
  if (key === undefined) {
    key = serializeFolderLineage(row)
    lineageKeys.set(row, key)
  }
  return key
}

export function toFolderListRow(row: Worktree): FolderListRow {
  let listRow = listRows.get(row)
  if (listRow === undefined) {
    listRow = {
      worktreeId: row.worktreeId,
      hostId: row.hostId,
      repo: row.repo,
      displayName: row.displayName,
      branch: row.branch
    }
    listRows.set(row, listRow)
  }
  return listRow
}

/** The folder workspace row a Source Control route names; a route without a server means the paired desktop's own. */
export function findFolderWorkspaceRow<Row extends FolderLineageRow>(
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
export function getFolderAttachedWorktrees<Row extends FolderLineageRow>(
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
