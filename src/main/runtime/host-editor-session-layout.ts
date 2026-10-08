import type { RuntimeMobileSessionTabGroup } from '../../shared/runtime-types'
import type { TabGroup, TabGroupLayoutNode } from '../../shared/tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import {
  isUnifiedWorkspaceSession,
  listHostEditTabs,
  pickTargetGroup,
  type HostEditTabRecord
} from './host-editor-session-model'
import {
  pruneTabGroupLayoutAfterRetirement,
  repairMobileSessionTabGroupsAfterRetirement
} from './mobile-session-terminal-retirement'

// Why a separate module: closing and moving rewrite group layout, which opening never does.

/** Closes the file entity behind `record`: every wrapper of it goes, like a window entity close. */
export function closeHostEditFile(
  session: WorkspaceSessionState,
  worktreeId: string,
  record: Pick<HostEditTabRecord, 'fileId' | 'wrapperEntityId' | 'file'>
): WorkspaceSessionState {
  const closingTabIds = new Set(
    listHostEditTabs(session, worktreeId)
      .filter((candidate) => candidate.fileId === record.fileId)
      .map((candidate) => candidate.tabId)
  )
  const rows = (session.openFilesByWorktree?.[worktreeId] ?? []).filter(
    (row) =>
      !(
        row.filePath === record.file.filePath &&
        (row.runtimeEnvironmentId ?? null) === (record.file.runtimeEnvironmentId ?? null)
      )
  )
  const wasActiveFile = session.activeFileIdByWorktree?.[worktreeId] === record.fileId
  let next: WorkspaceSessionState = {
    ...session,
    openFilesByWorktree: { ...session.openFilesByWorktree, [worktreeId]: rows }
  }
  if (session.unifiedTabs?.[worktreeId]) {
    const remaining = session.unifiedTabs[worktreeId].filter(
      (tab) =>
        !(
          tab.contentType === 'editor' &&
          ((tab.entityId ?? tab.id) === record.wrapperEntityId || closingTabIds.has(tab.id))
        )
    )
    next = { ...next, unifiedTabs: { ...session.unifiedTabs, [worktreeId]: remaining } }
  }
  next = retireTopLevelIdsFromPersistedGroups(next, worktreeId, closingTabIds)
  if (wasActiveFile) {
    next = refocusAfterEditorClose(next, worktreeId)
  }
  return next
}

/** Drops `tabIds` from the persisted groups, repairing focus and collapsing emptied splits. */
export function retireTopLevelIdsFromPersistedGroups(
  session: WorkspaceSessionState,
  worktreeId: string,
  tabIds: ReadonlySet<string>
): WorkspaceSessionState {
  const groups = session.tabGroups?.[worktreeId]
  if (!groups || tabIds.size === 0) {
    return session
  }
  const retained = new Set(
    groups.flatMap((group) => group.tabOrder).filter((id) => !tabIds.has(id))
  )
  const repaired = repairMobileSessionTabGroupsAfterRetirement(groups, retained)
  // Why keep the last group: a window restores an empty single group but drops a missing one.
  const nextGroups: TabGroup[] = repaired
    ? repaired.map((group) => ({ ...group, worktreeId }))
    : groups.slice(0, 1).map((group) => ({
        ...group,
        tabOrder: [],
        activeTabId: null,
        recentTabIds: []
      }))
  const liveGroupIds = new Set(nextGroups.map((group) => group.id))
  const layout = session.tabGroupLayouts?.[worktreeId]
  const nextLayout = layout ? pruneTabGroupLayoutAfterRetirement(layout, liveGroupIds) : undefined
  const activeGroupId = session.activeGroupIdByWorktree?.[worktreeId]
  return {
    ...session,
    tabGroups: { ...session.tabGroups, [worktreeId]: nextGroups },
    ...(layout
      ? {
          tabGroupLayouts: {
            ...session.tabGroupLayouts,
            [worktreeId]: nextLayout ?? { type: 'leaf', groupId: nextGroups[0]!.id }
          }
        }
      : {}),
    ...(activeGroupId && !liveGroupIds.has(activeGroupId)
      ? {
          activeGroupIdByWorktree: {
            ...session.activeGroupIdByWorktree,
            [worktreeId]: nextGroups[0]!.id
          }
        }
      : {})
  }
}

function refocusAfterEditorClose(
  session: WorkspaceSessionState,
  worktreeId: string
): WorkspaceSessionState {
  const records = listHostEditTabs(session, worktreeId)
  const group = pickTargetGroup(session, worktreeId)
  const groupActive = group?.activeTabId
    ? records.find((record) => record.tabId === group.activeTabId)
    : undefined
  // Why: legacy sessions have no group focus; prefer a terminal when one exists, like legacy restore.
  const fallback =
    groupActive ??
    (isUnifiedWorkspaceSession(session) || (session.tabsByWorktree[worktreeId]?.length ?? 0) > 0
      ? undefined
      : records.at(-1))
  return {
    ...session,
    activeFileIdByWorktree: {
      ...session.activeFileIdByWorktree,
      [worktreeId]: fallback?.fileId ?? null
    },
    activeTabTypeByWorktree: {
      ...session.activeTabTypeByWorktree,
      [worktreeId]: fallback ? 'editor' : 'terminal'
    }
  }
}

/**
 * Persists a legacy session's host-side group layout (after a move, split or reorder): its only
 * groups are the headless ones, so the snapshot's are the whole model. Transient tabs (host
 * diffs) are left out: the session holds only what a window would persist. Unified sessions are
 * edited instead (`editPersistedTabGroups`).
 */
export function persistHostTabGroupLayout(
  session: WorkspaceSessionState,
  worktreeId: string,
  layout: {
    groups: readonly RuntimeMobileSessionTabGroup[]
    groupLayout: TabGroupLayoutNode | null | undefined
    activeGroupId: string | null
    transientTabIds?: ReadonlySet<string>
  }
): WorkspaceSessionState {
  // Why: a window migrates a wrapper named by its legacy file id, so the snapshot id can differ from the persisted one.
  const persistedIdByTabId = new Map(
    listHostEditTabs(session, worktreeId).flatMap((record) =>
      record.wrapperId && record.wrapperId !== record.tabId
        ? [[record.tabId, record.wrapperId] as const]
        : []
    )
  )
  const toPersistedId = (tabId: string): string => persistedIdByTabId.get(tabId) ?? tabId
  const groups: TabGroup[] = layout.groups.map((group) => ({
    id: group.id,
    worktreeId,
    activeTabId: group.activeTabId ? toPersistedId(group.activeTabId) : null,
    tabOrder: group.tabOrder.map(toPersistedId),
    ...(group.recentTabIds ? { recentTabIds: group.recentTabIds.map(toPersistedId) } : {})
  }))
  const placementByTabId = new Map<string, { groupId: string; sortOrder: number }>()
  for (const group of groups) {
    group.tabOrder.forEach((tabId, index) => {
      placementByTabId.set(tabId, { groupId: group.id, sortOrder: index })
    })
  }
  const wrappers = session.unifiedTabs?.[worktreeId]
  const nextWrappers = wrappers?.map((tab) => {
    const placement = placementByTabId.get(tab.id)
    return placement && (placement.groupId !== tab.groupId || placement.sortOrder !== tab.sortOrder)
      ? { ...tab, ...placement }
      : tab
  })
  const groupLayout =
    layout.groupLayout ?? (groups[0] ? { type: 'leaf' as const, groupId: groups[0].id } : null)
  const next: WorkspaceSessionState = {
    ...session,
    tabGroups: { ...session.tabGroups, [worktreeId]: groups },
    ...(groupLayout
      ? { tabGroupLayouts: { ...session.tabGroupLayouts, [worktreeId]: groupLayout } }
      : {}),
    ...(nextWrappers
      ? { unifiedTabs: { ...session.unifiedTabs, [worktreeId]: nextWrappers } }
      : {}),
    ...(layout.activeGroupId
      ? {
          activeGroupIdByWorktree: {
            ...session.activeGroupIdByWorktree,
            [worktreeId]: layout.activeGroupId
          }
        }
      : {})
  }
  return retireTopLevelIdsFromPersistedGroups(next, worktreeId, layout.transientTabIds ?? new Set())
}
