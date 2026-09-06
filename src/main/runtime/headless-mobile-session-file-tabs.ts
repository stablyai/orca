import type {
  RuntimeMobileSessionFileTab,
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabGroup,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'

type OpenHeadlessMobileSessionFileTabArgs = {
  worktreeId: string
  filePath: string
  relativePath: string
  language: string
  mode?: 'edit' | 'diff'
  diffSource?: 'staged' | 'unstaged'
  tabId: string
  defaultGroupId: string
  now: number
}

export function openHeadlessMobileSessionFileTab(
  snapshot: RuntimeMobileSessionTabsSnapshot | undefined,
  args: OpenHeadlessMobileSessionFileTabArgs
): RuntimeMobileSessionTabsSnapshot {
  const existing = snapshot?.tabs.find(
    (tab): tab is RuntimeMobileSessionFileTab =>
      tab.type === 'file' &&
      (tab.mode ?? 'edit') === (args.mode ?? 'edit') &&
      (args.mode !== 'diff' || tab.diffSource === args.diffSource) &&
      (tab.filePath === args.filePath || tab.relativePath === args.relativePath)
  )
  const tabId = existing?.id ?? args.tabId
  const targetGroupId =
    findTabGroup(snapshot?.tabGroups, tabId)?.id ??
    findTabGroup(snapshot?.tabGroups, snapshot?.activeTabId ?? null)?.id ??
    snapshot?.tabGroups?.find((group) => group.id === snapshot.activeGroupId)?.id ??
    snapshot?.tabGroups?.[0]?.id ??
    args.defaultGroupId
  const title = displayName(args.relativePath)
  const activeTab: RuntimeMobileSessionFileTab = {
    type: 'file',
    id: tabId,
    title,
    filePath: args.filePath,
    relativePath: args.relativePath,
    language: args.language,
    mode: args.mode ?? 'edit',
    ...(args.diffSource ? { diffSource: args.diffSource } : {}),
    isDirty: existing?.isDirty ?? false,
    ...(existing?.color !== undefined ? { color: existing.color } : {}),
    ...(existing?.isPinned !== undefined ? { isPinned: existing.isPinned } : {}),
    isActive: true
  }
  const tabs = activateFileTab(snapshot?.tabs ?? [], activeTab)
  const tabGroups = activateFileTabGroup(snapshot?.tabGroups ?? [], targetGroupId, tabId)
  return {
    worktree: args.worktreeId,
    publicationEpoch: `headless:${args.now.toString(36)}`,
    snapshotVersion: (snapshot?.snapshotVersion ?? 0) + 1,
    activeGroupId: targetGroupId,
    activeTabId: tabId,
    activeTabType: 'file',
    ...(snapshot?.tabGroupLayout ? { tabGroupLayout: snapshot.tabGroupLayout } : {}),
    tabGroups,
    tabs
  }
}

export function closeHeadlessMobileSessionFileTab(
  snapshot: RuntimeMobileSessionTabsSnapshot,
  tabId: string,
  now: number
): RuntimeMobileSessionTabsSnapshot {
  const closing = snapshot.tabs.find(
    (tab): tab is RuntimeMobileSessionFileTab => tab.type === 'file' && tab.id === tabId
  )
  if (!closing) {
    return snapshot
  }
  const tabs = snapshot.tabs.filter((tab) => tab.id !== tabId)
  const closingGroup = findTabGroup(snapshot.tabGroups, tabId)
  const tabGroups = (snapshot.tabGroups ?? []).map((group) => closeFileTabFromGroup(group, tabId))
  const nextActiveId =
    closingGroup?.tabOrder
      .filter((candidate) => candidate !== tabId)
      .findLast((candidate) => tabs.some((tab) => topLevelId(tab) === candidate)) ??
    tabGroups
      .flatMap((group) => group.tabOrder)
      .find((candidate) => tabs.some((tab) => topLevelId(tab) === candidate)) ??
    null
  const nextActive =
    tabs.find((tab) => tab.id === nextActiveId) ??
    tabs.find((tab) => tab.type === 'terminal' && tab.parentTabId === nextActiveId) ??
    tabs[0] ??
    null
  const activeTabs = tabs.map((tab) => ({ ...tab, isActive: tab.id === nextActive?.id }))
  return {
    ...snapshot,
    publicationEpoch: `headless:${now.toString(36)}`,
    snapshotVersion: snapshot.snapshotVersion + 1,
    activeGroupId:
      findTabGroup(tabGroups, nextActiveId)?.id ?? tabGroups[0]?.id ?? snapshot.activeGroupId,
    activeTabId: nextActive?.id ?? null,
    activeTabType: nextActive?.type ?? null,
    tabGroups,
    tabs: activeTabs
  }
}

function activateFileTab(
  tabs: readonly RuntimeMobileSessionSnapshotTab[],
  activeTab: RuntimeMobileSessionFileTab
): RuntimeMobileSessionSnapshotTab[] {
  let replaced = false
  const next = tabs.map((tab) => {
    if (tab.id === activeTab.id) {
      replaced = true
      return activeTab
    }
    return { ...tab, isActive: false }
  })
  return replaced ? next : [...next, activeTab]
}

function activateFileTabGroup(
  groups: readonly RuntimeMobileSessionTabGroup[],
  targetGroupId: string,
  tabId: string
): RuntimeMobileSessionTabGroup[] {
  const source = groups.length > 0 ? groups : [emptyGroup(targetGroupId)]
  const targetAlreadyContainsTab = source.some(
    (group) => group.id === targetGroupId && group.tabOrder.includes(tabId)
  )
  return source.map((group) => {
    if (group.id !== targetGroupId) {
      return targetAlreadyContainsTab
        ? group
        : { ...group, tabOrder: group.tabOrder.filter((candidate) => candidate !== tabId) }
    }
    const nextOrder = group.tabOrder.includes(tabId) ? group.tabOrder : [...group.tabOrder, tabId]
    return {
      ...group,
      activeTabId: tabId,
      tabOrder: nextOrder,
      recentTabIds: [...(group.recentTabIds ?? []).filter((id) => id !== tabId), tabId]
    }
  })
}

function closeFileTabFromGroup(
  group: RuntimeMobileSessionTabGroup,
  tabId: string
): RuntimeMobileSessionTabGroup {
  const tabOrder = group.tabOrder.filter((candidate) => candidate !== tabId)
  const recentTabIds = group.recentTabIds?.filter((candidate) => candidate !== tabId)
  return {
    ...group,
    activeTabId:
      group.activeTabId === tabId
        ? (recentTabIds?.at(-1) ?? tabOrder.at(-1) ?? null)
        : group.activeTabId,
    tabOrder,
    ...(recentTabIds ? { recentTabIds } : {})
  }
}

function findTabGroup(
  groups: readonly RuntimeMobileSessionTabGroup[] | undefined,
  tabId: string | null
): RuntimeMobileSessionTabGroup | undefined {
  return tabId ? groups?.find((group) => group.tabOrder.includes(tabId)) : undefined
}

function topLevelId(tab: RuntimeMobileSessionSnapshotTab): string {
  return tab.type === 'terminal' ? tab.parentTabId : tab.id
}

function emptyGroup(id: string): RuntimeMobileSessionTabGroup {
  return { id, activeTabId: null, tabOrder: [] }
}

function displayName(relativePath: string): string {
  return relativePath.split(/[\\/]/).findLast(Boolean) ?? 'File'
}
