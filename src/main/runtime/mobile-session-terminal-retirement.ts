import type {
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabGroup,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab
} from '../../shared/runtime-types'
import type {
  TabGroupLayoutNode,
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode
} from '../../shared/types'

export type RetiredTerminalSurface = {
  worktreeId: string
  parentTabId: string
  leafId: string
  ptyId: string
  incarnationId?: string
  retiredAt?: number
}

function pruneTerminalPane(
  node: TerminalPaneLayoutNode | null,
  retiredLeafIds: ReadonlySet<string>
): TerminalPaneLayoutNode | null {
  if (!node) {
    return null
  }
  if (node.type === 'leaf') {
    return retiredLeafIds.has(node.leafId) ? null : node
  }
  const first = pruneTerminalPane(node.first, retiredLeafIds)
  const second = pruneTerminalPane(node.second, retiredLeafIds)
  if (first && second) {
    return { ...node, first, second }
  }
  return first ?? second
}

function collectTerminalLeafIds(node: TerminalPaneLayoutNode | null): string[] {
  if (!node) {
    return []
  }
  return node.type === 'leaf'
    ? [node.leafId]
    : [...collectTerminalLeafIds(node.first), ...collectTerminalLeafIds(node.second)]
}

function omitLeafRecords<T>(
  values: Record<string, T> | undefined,
  retiredLeafIds: ReadonlySet<string>
): Record<string, T> | undefined {
  if (!values) {
    return undefined
  }
  const retained = Object.fromEntries(
    Object.entries(values).filter(([leafId]) => !retiredLeafIds.has(leafId))
  )
  return Object.keys(retained).length > 0 ? retained : undefined
}

export function retireLeavesFromTerminalLayout(
  layout: TerminalLayoutSnapshot,
  retiredLeafIds: ReadonlySet<string>
): TerminalLayoutSnapshot | null {
  const root = pruneTerminalPane(layout.root, retiredLeafIds)
  if (!root) {
    return null
  }
  const retainedLeafIds = collectTerminalLeafIds(root)
  const retainedLeafIdSet = new Set(retainedLeafIds)
  const activeLeafId =
    layout.activeLeafId && retainedLeafIdSet.has(layout.activeLeafId)
      ? layout.activeLeafId
      : retainedLeafIds[0]!
  return {
    ...layout,
    root,
    activeLeafId,
    expandedLeafId:
      layout.expandedLeafId && retainedLeafIdSet.has(layout.expandedLeafId)
        ? layout.expandedLeafId
        : null,
    ptyIdsByLeafId: omitLeafRecords(layout.ptyIdsByLeafId, retiredLeafIds),
    buffersByLeafId: omitLeafRecords(layout.buffersByLeafId, retiredLeafIds),
    scrollbackRefsByLeafId: omitLeafRecords(layout.scrollbackRefsByLeafId, retiredLeafIds),
    titlesByLeafId: omitLeafRecords(layout.titlesByLeafId, retiredLeafIds)
  }
}

export function pruneTabGroupLayoutAfterRetirement(
  layout: TabGroupLayoutNode | undefined,
  retainedGroupIds: ReadonlySet<string>
): TabGroupLayoutNode | undefined {
  if (!layout) {
    return undefined
  }
  if (layout.type === 'leaf') {
    return retainedGroupIds.has(layout.groupId) ? layout : undefined
  }
  const first = pruneTabGroupLayoutAfterRetirement(layout.first, retainedGroupIds)
  const second = pruneTabGroupLayoutAfterRetirement(layout.second, retainedGroupIds)
  if (first && second) {
    return { ...layout, first, second }
  }
  return first ?? second
}

function chooseGroupActiveTab(
  group: RuntimeMobileSessionTabGroup,
  retainedTabIds: ReadonlySet<string>
): string | null {
  if (group.activeTabId && retainedTabIds.has(group.activeTabId)) {
    return group.activeTabId
  }
  const recent = (group.recentTabIds ?? []).toReversed().find((tabId) => retainedTabIds.has(tabId))
  return recent ?? group.tabOrder.find((tabId) => retainedTabIds.has(tabId)) ?? null
}

export function repairMobileSessionTabGroupsAfterRetirement(
  groups: readonly RuntimeMobileSessionTabGroup[] | undefined,
  validTopLevelIds: ReadonlySet<string>
): RuntimeMobileSessionTabGroup[] | undefined {
  if (!groups) {
    return undefined
  }
  const repaired = groups.flatMap((group) => {
    const tabOrder = group.tabOrder.filter((tabId) => validTopLevelIds.has(tabId))
    if (tabOrder.length === 0) {
      return []
    }
    const retained = new Set(tabOrder)
    const recentTabIds = group.recentTabIds?.filter((tabId) => retained.has(tabId))
    return [
      {
        ...group,
        tabOrder,
        activeTabId: chooseGroupActiveTab(group, retained),
        ...(recentTabIds && recentTabIds.length > 0 ? { recentTabIds } : {})
      }
    ]
  })
  return repaired.length > 0 ? repaired : undefined
}

function topLevelTabId(tab: RuntimeMobileSessionSnapshotTab): string {
  return tab.type === 'terminal' ? tab.parentTabId : tab.id
}

function chooseActiveSurface(
  tabs: readonly RuntimeMobileSessionSnapshotTab[],
  previousActiveId: string | null,
  groups: readonly RuntimeMobileSessionTabGroup[] | undefined,
  previousActiveGroupId: string | null
): RuntimeMobileSessionSnapshotTab | null {
  const previous = previousActiveId ? tabs.find((tab) => tab.id === previousActiveId) : undefined
  if (previous) {
    return previous
  }
  const activeGroup =
    groups?.find((group) => group.id === previousActiveGroupId) ?? groups?.[0] ?? null
  const activeTopLevelId = activeGroup?.activeTabId
  return (
    (activeTopLevelId
      ? (tabs.find((tab) => topLevelTabId(tab) === activeTopLevelId && tab.isActive) ??
        tabs.find((tab) => topLevelTabId(tab) === activeTopLevelId))
      : undefined) ??
    tabs.find((tab) => tab.isActive) ??
    tabs[0] ??
    null
  )
}

function terminalMatchesRetirement(
  tab: RuntimeMobileSessionTerminalTab,
  ptyId: string,
  exactSurfaceKeys: ReadonlySet<string>,
  exactOnly: boolean
): boolean {
  const surfaceKey = `${tab.parentTabId}\0${tab.leafId}`
  if (exactSurfaceKeys.has(surfaceKey)) {
    const leafPtyId = tab.parentLayout?.ptyIdsByLeafId?.[tab.leafId]
    return (!tab.ptyId || tab.ptyId === ptyId) && (!leafPtyId || leafPtyId === ptyId)
  }
  if (exactOnly) {
    return false
  }
  return tab.ptyId === ptyId || tab.parentLayout?.ptyIdsByLeafId?.[tab.leafId] === ptyId
}

export function retireTerminalSurfacesFromSnapshot(args: {
  snapshot: RuntimeMobileSessionTabsSnapshot
  ptyId: string
  exactSurfaces?: readonly Pick<RetiredTerminalSurface, 'parentTabId' | 'leafId'>[]
  exactOnly?: boolean
}): { snapshot: RuntimeMobileSessionTabsSnapshot; retired: RetiredTerminalSurface[] } | null {
  const exactSurfaceKeys = new Set(
    (args.exactSurfaces ?? []).map((surface) => `${surface.parentTabId}\0${surface.leafId}`)
  )
  const retiredTabs = args.snapshot.tabs.filter(
    (tab): tab is RuntimeMobileSessionTerminalTab =>
      tab.type === 'terminal' &&
      terminalMatchesRetirement(tab, args.ptyId, exactSurfaceKeys, args.exactOnly === true)
  )
  if (retiredTabs.length === 0) {
    return null
  }

  const retiredLeafIdsByParent = new Map<string, Set<string>>()
  for (const tab of retiredTabs) {
    const leafIds = retiredLeafIdsByParent.get(tab.parentTabId) ?? new Set<string>()
    leafIds.add(tab.leafId)
    retiredLeafIdsByParent.set(tab.parentTabId, leafIds)
  }
  const retiredIds = new Set(retiredTabs.map((tab) => tab.id))
  let tabs = args.snapshot.tabs.filter((tab) => !retiredIds.has(tab.id))
  tabs = tabs.map((tab) => {
    if (tab.type !== 'terminal') {
      return tab
    }
    const retiredLeafIds = retiredLeafIdsByParent.get(tab.parentTabId)
    if (!retiredLeafIds) {
      return tab
    }
    const sourceLayout =
      tab.parentLayout ??
      retiredTabs.find((retired) => retired.parentTabId === tab.parentTabId)?.parentLayout
    const parentLayout = sourceLayout
      ? retireLeavesFromTerminalLayout(sourceLayout, retiredLeafIds)
      : undefined
    return {
      ...tab,
      ...(parentLayout ? { parentLayout } : {}),
      isActive:
        tab.isActive ||
        retiredTabs.some((retired) => retired.parentTabId === tab.parentTabId && retired.isActive)
    }
  })

  const validTopLevelIds = new Set(tabs.map(topLevelTabId))
  const tabGroups = repairMobileSessionTabGroupsAfterRetirement(
    args.snapshot.tabGroups,
    validTopLevelIds
  )
  const active = chooseActiveSurface(
    tabs,
    args.snapshot.activeTabId,
    tabGroups,
    args.snapshot.activeGroupId
  )
  tabs = tabs.map((tab) => ({ ...tab, isActive: tab.id === active?.id }))
  const activeTopLevelId = active ? topLevelTabId(active) : null
  const activeGroupId =
    (activeTopLevelId
      ? tabGroups?.find((group) => group.tabOrder.includes(activeTopLevelId))?.id
      : undefined) ??
    tabGroups?.[0]?.id ??
    null
  const retainedGroupIds = new Set(tabGroups?.map((group) => group.id) ?? [])

  return {
    snapshot: {
      ...args.snapshot,
      snapshotVersion: args.snapshot.snapshotVersion + 1,
      activeGroupId,
      activeTabId: active?.id ?? null,
      activeTabType: active?.type ?? null,
      ...(tabGroups ? { tabGroups } : { tabGroups: undefined }),
      ...(args.snapshot.tabGroupLayout
        ? {
            tabGroupLayout: pruneTabGroupLayoutAfterRetirement(
              args.snapshot.tabGroupLayout,
              retainedGroupIds
            )
          }
        : {}),
      tabs
    },
    retired: retiredTabs.map((tab) => ({
      worktreeId: args.snapshot.worktree,
      parentTabId: tab.parentTabId,
      leafId: tab.leafId,
      ptyId: args.ptyId
    }))
  }
}
