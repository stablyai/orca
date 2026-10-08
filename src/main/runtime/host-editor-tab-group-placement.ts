import type {
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabGroup,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import type { Tab, TabGroupLayoutNode } from '../../shared/tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import {
  translateSnapshotTabIds,
  type SnapshotTabIdTranslation
} from './host-editor-tab-group-edit'
import type { HostEditorMobileTab } from './host-editor-tab-projection'
import {
  collectHeadlessTopLevelTabOrder,
  getHeadlessMobileSessionGroupId
} from './mobile-session-layout-projection'
import {
  pruneTabGroupLayoutAfterRetirement,
  repairMobileSessionTabGroupsAfterRetirement
} from './mobile-session-terminal-retirement'

function insertByPersistedOrder(
  tabOrder: readonly string[],
  tabId: string,
  persistedOrder: readonly string[] | undefined
): string[] {
  const next = tabOrder.filter((id) => id !== tabId)
  const persistedIndex = persistedOrder?.indexOf(tabId) ?? -1
  if (!persistedOrder || persistedIndex < 0) {
    return [...next, tabId]
  }
  for (let index = persistedIndex - 1; index >= 0; index -= 1) {
    const anchor = next.indexOf(persistedOrder[index]!)
    if (anchor !== -1) {
      next.splice(anchor + 1, 0, tabId)
      return next
    }
  }
  return [tabId, ...next]
}

/** Snapshot ↔ wrapper ids for every tab kind a host snapshot carries, editors included. */
export function translateHostSnapshotTabIds(
  tabs: readonly RuntimeMobileSessionSnapshotTab[],
  editors: readonly HostEditorMobileTab[],
  wrappers: readonly Tab[]
): SnapshotTabIdTranslation {
  return translateSnapshotTabIds(
    tabs,
    wrappers,
    new Map(
      editors.flatMap((editor) =>
        editor.persistedTabId ? [[editor.tab.id, editor.persistedTabId] as const] : []
      )
    )
  )
}

export type ProjectedTabGroups = {
  groups: RuntimeMobileSessionTabGroup[]
  layout: TabGroupLayoutNode | undefined
}

/**
 * A unified session's groups are the window's groups, so every tab (terminal, browser, editor)
 * is placed through them; a separate terminal group would show phones a split the window never had.
 */
export function projectPersistedTabGroups(
  snapshot: RuntimeMobileSessionTabsSnapshot,
  baseTabs: readonly RuntimeMobileSessionSnapshotTab[],
  editors: readonly HostEditorMobileTab[],
  session: WorkspaceSessionState
): ProjectedTabGroups | null {
  const worktreeId = snapshot.worktree
  const persisted = session.tabGroups?.[worktreeId] ?? []
  if (persisted.length === 0) {
    return null
  }
  const { toSnapshotId } = translateHostSnapshotTabIds(
    [...baseTabs, ...editors.map((editor) => editor.tab)],
    editors,
    session.unifiedTabs?.[worktreeId] ?? []
  )
  const topLevelIds = [
    ...collectHeadlessTopLevelTabOrder(baseTabs),
    ...editors.map((editor) => editor.tab.id)
  ]
  const present = new Set(topLevelIds)
  const groups: RuntimeMobileSessionTabGroup[] = persisted.map((group) => ({
    id: group.id,
    activeTabId: group.activeTabId ? toSnapshotId(group.activeTabId) : null,
    tabOrder: group.tabOrder.map(toSnapshotId).filter((tabId) => present.has(tabId)),
    ...(group.recentTabIds ? { recentTabIds: group.recentTabIds.map(toSnapshotId) } : {})
  }))
  const placed = new Set(groups.flatMap((group) => group.tabOrder))
  const groupIdByEditorId = new Map(editors.map((editor) => [editor.tab.id, editor.groupId]))
  const groupIdByWrapperId = new Map(
    (session.unifiedTabs?.[worktreeId] ?? []).map((tab) => [toSnapshotId(tab.id), tab.groupId])
  )
  const snapshotGroupByTabId = new Map(
    (snapshot.tabGroups ?? []).flatMap((group) =>
      group.tabOrder.map((tabId) => [tabId, group] as const)
    )
  )
  for (const tabId of topLevelIds) {
    if (placed.has(tabId)) {
      continue
    }
    // Why: live-only tabs (host diffs, unwrapped terminals) keep the group and position phones saw.
    const snapshotGroup = snapshotGroupByTabId.get(tabId)
    const target =
      [
        groupIdByEditorId.get(tabId),
        groupIdByWrapperId.get(tabId),
        snapshotGroup?.id,
        snapshot.activeGroupId,
        session.activeGroupIdByWorktree?.[worktreeId]
      ]
        .map((groupId) => (groupId ? groups.find((group) => group.id === groupId) : undefined))
        .find((group) => group !== undefined) ?? groups[0]!
    target.tabOrder = insertByPersistedOrder(target.tabOrder, tabId, snapshotGroup?.tabOrder)
  }
  const repaired = repairMobileSessionTabGroupsAfterRetirement(groups, present) ?? [
    { ...groups[0]!, activeTabId: null, tabOrder: [] }
  ]
  const liveGroupIds = new Set(repaired.map((group) => group.id))
  const layout =
    repaired.length > 1
      ? (pruneTabGroupLayoutAfterRetirement(session.tabGroupLayouts?.[worktreeId], liveGroupIds) ??
        pruneTabGroupLayoutAfterRetirement(snapshot.tabGroupLayout ?? undefined, liveGroupIds))
      : undefined
  return { groups: repaired, layout }
}

/** A legacy session has no window groups: editors join the snapshot's groups by persisted position. */
export function placeEditorsInSnapshotGroups(
  snapshot: RuntimeMobileSessionTabsSnapshot,
  baseTabs: readonly RuntimeMobileSessionSnapshotTab[],
  editors: readonly HostEditorMobileTab[],
  session: WorkspaceSessionState | null,
  previousEditorIds: ReadonlySet<string>
): RuntimeMobileSessionTabGroup[] {
  const worktreeId = snapshot.worktree
  const editorIds = new Set(editors.map((editor) => editor.tab.id))
  let groups: RuntimeMobileSessionTabGroup[] = (snapshot.tabGroups ?? []).map((group) => {
    const tabOrder = group.tabOrder.filter((id) => !previousEditorIds.has(id) || editorIds.has(id))
    return {
      ...group,
      tabOrder,
      activeTabId:
        group.activeTabId && tabOrder.includes(group.activeTabId) ? group.activeTabId : null
    }
  })
  if (groups.length === 0 && editors.length > 0) {
    groups = [
      {
        id: snapshot.activeGroupId ?? getHeadlessMobileSessionGroupId(worktreeId),
        activeTabId: null,
        tabOrder: collectHeadlessTopLevelTabOrder(baseTabs)
      }
    ]
  }
  const persistedGroupsById = new Map(
    (session?.tabGroups?.[worktreeId] ?? []).map((group) => [group.id, group])
  )
  for (const editor of editors) {
    const alreadyPlaced = groups.find((group) => group.tabOrder.includes(editor.tab.id))
    if (alreadyPlaced) {
      continue
    }
    const target =
      groups.find((group) => group.id === editor.groupId) ??
      groups.find((group) => group.id === snapshot.activeGroupId) ??
      groups[0]!
    const persistedOrder = persistedGroupsById.get(target.id)?.tabOrder
    groups = groups.map((group) =>
      group.id === target.id
        ? {
            ...group,
            tabOrder: insertByPersistedOrder(group.tabOrder, editor.tab.id, persistedOrder)
          }
        : group
    )
  }
  return groups.filter((group, index) => group.tabOrder.length > 0 || index === 0)
}
