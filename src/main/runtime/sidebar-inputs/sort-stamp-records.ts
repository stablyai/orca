import type { AgentPaneWorkspace } from '../../agent-hooks/agent-transition-detector'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type {
  SmartStampFields,
  SmartTier,
  SortStamps
} from '../../../shared/sidebar-list/sort-stamps'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../../shared/workspace-scope'

type StampedRecord = { lastActivityAt: number; isUnread?: boolean } & SmartStampFields
type StampUpdates = {
  lastActivityAt: number
  smartTier: SmartTier | undefined
  smartAt: number | undefined
}

/** The per-workspace record reads and writes, which the runtime's store satisfies. */
export type WorkspaceRecordStore<TRecord, TUpdates> = {
  getWorktreeMeta: (worktreeId: string) => TRecord | undefined
  setWorktreeMeta: (worktreeId: string, updates: TUpdates) => unknown
  getWorktreeMetaForHost?: (worktreeId: string, hostId: ExecutionHostId) => TRecord | undefined
  setWorktreeMetaForHost?: (
    worktreeId: string,
    hostId: ExecutionHostId,
    updates: TUpdates
  ) => unknown
  getFolderWorkspace?: (folderWorkspaceId: string) => TRecord | undefined
  updateFolderWorkspace?: (folderWorkspaceId: string, updates: TUpdates) => unknown
}

type UnreadUpdate = { isUnread: boolean }

/** The record reads and writes stamping and the unread flag need. */
export type SortStampsStore = WorkspaceRecordStore<StampedRecord, StampUpdates | UnreadUpdate> & {
  getAllWorktreeMeta?: () => Record<string, StampedRecord>
  getFolderWorkspaces?: () => readonly (StampedRecord & { id: string })[]
}

/** The workspace's own record: folder, SSH host, or local. */
export function readWorkspaceRecord<TRecord>(
  store: WorkspaceRecordStore<TRecord, never> | null,
  { worktreeId, sshHostId }: AgentPaneWorkspace
): TRecord | undefined {
  const scope = parseWorkspaceKey(worktreeId)
  return scope?.type === 'folder'
    ? store?.getFolderWorkspace?.(scope.folderWorkspaceId)
    : sshHostId
      ? store?.getWorktreeMetaForHost?.(worktreeId, sshHostId)
      : store?.getWorktreeMeta(worktreeId)
}

export function writeWorkspaceRecord<TUpdates>(
  store: WorkspaceRecordStore<unknown, TUpdates> | null,
  { worktreeId, sshHostId }: AgentPaneWorkspace,
  updates: TUpdates
): void {
  const scope = parseWorkspaceKey(worktreeId)
  if (scope?.type === 'folder') {
    store?.updateFolderWorkspace?.(scope.folderWorkspaceId, updates)
  } else if (sshHostId) {
    store?.setWorktreeMetaForHost?.(worktreeId, sshHostId, updates)
  } else {
    store?.setWorktreeMeta(worktreeId, updates)
  }
}

/** Sets the workspace's unread flag; true when its record held the other value. */
export function writeUnreadFlag(
  store: SortStampsStore | null,
  workspace: AgentPaneWorkspace,
  isUnread: boolean
): boolean {
  const record = readWorkspaceRecord(store, workspace)
  // Only a workspace with a record is written; writing would create one for a stale id.
  if (!record || Boolean(record.isUnread) === isUnread) {
    return false
  }
  writeWorkspaceRecord<UnreadUpdate>(store, workspace, { isUnread })
  return true
}

// Only a workspace with a record is stamped; writing would create one for a stale id.
export function readSortStamps(
  store: SortStampsStore | null,
  workspace: AgentPaneWorkspace
): SortStamps | null {
  const record = readWorkspaceRecord(store, workspace)
  if (!record) {
    return null
  }
  return {
    recentAt: record.lastActivityAt,
    ...(record.smartTier !== undefined
      ? { smartTier: record.smartTier, smartAt: record.smartAt }
      : {})
  }
}

export function writeSortStamps(
  store: SortStampsStore | null,
  workspace: AgentPaneWorkspace,
  stamps: SortStamps
): void {
  // Both tier keys are always written, so Rest clears them.
  writeWorkspaceRecord<StampUpdates>(store, workspace, {
    lastActivityAt: stamps.recentAt,
    smartTier: stamps.smartTier,
    smartAt: stamps.smartAt
  })
}

/** Every workspace whose record holds a tier. */
export function listTieredWorkspaces(store: SortStampsStore | null): string[] {
  const ids: string[] = []
  for (const [worktreeId, meta] of Object.entries(store?.getAllWorktreeMeta?.() ?? {})) {
    if (meta.smartTier !== undefined) {
      ids.push(worktreeId)
    }
  }
  for (const folder of store?.getFolderWorkspaces?.() ?? []) {
    if (folder.smartTier !== undefined) {
      ids.push(folderWorkspaceKey(folder.id))
    }
  }
  return ids
}
