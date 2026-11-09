import { getHeadlessMobileSessionGroupId } from '../terminal/surface/mobile-session-layout-projection'
import type { RuntimeMobileSessionSnapshotTab } from '../../../shared/runtime-mobile-session-tab-contracts'
import type {
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTabGroup
} from '../../../shared/runtime-session-contracts'

type Selection = {
  activeGroupId: string | null
  activeTabId: string | null
  activeTabType: RuntimeMobileSessionSnapshotTab['type'] | null
  tabGroups?: readonly RuntimeMobileSessionTabGroup[]
}

type Row = Pick<RuntimeMobileSessionSnapshotTab, 'id' | 'type' | 'isActive'> & {
  parentTabId?: string
  leafId?: string
  parentLayout?: { activeLeafId: string | null }
  browserWorkspaceId?: string
}

/** Navigation declares the target; missing inventory must not select another recipient. */
export function resolveMobileSessionActiveTab<T extends Row>(
  snapshot: Selection,
  tabs: readonly T[]
): T | null {
  const group = snapshot.tabGroups?.find((candidate) => candidate.id === snapshot.activeGroupId)
  if (snapshot.tabGroups !== undefined && !group?.activeTabId) {
    return null
  }
  const declared = group?.activeTabId ?? snapshot.activeTabId
  let exact: T | undefined
  let selected: T | undefined
  let focused: T | undefined
  let first: T | undefined
  for (const tab of tabs) {
    if (
      declared
        ? tab.id !== declared &&
          !(tab.type === 'terminal' && tab.parentTabId === declared) &&
          !(tab.type === 'browser' && tab.browserWorkspaceId === declared)
        : !tab.isActive
    ) {
      continue
    }
    first ??= tab
    if (tab.id === snapshot.activeTabId) {
      exact = tab
    }
    if (tab.isActive) {
      selected = tab
    }
    if (tab.type === 'terminal' && tab.leafId === tab.parentLayout?.activeLeafId) {
      focused = tab
    }
  }
  return exact ?? selected ?? focused ?? first ?? null
}

export function normalizeMobileSessionTabSelection<T extends Selection & { tabs: Row[] }>(
  snapshot: T
): T {
  const active = resolveMobileSessionActiveTab(snapshot, snapshot.tabs)
  const activeTabId = active?.id ?? null
  const activeTabType = active?.type ?? null
  let changed = snapshot.activeTabId !== activeTabId || snapshot.activeTabType !== activeTabType
  let tabs = snapshot.tabs
  for (let index = 0; index < tabs.length; index++) {
    const tab = tabs[index]!
    const isActive = tab === active
    if (tab.isActive === isActive) {
      continue
    }
    if (tabs === snapshot.tabs) {
      tabs = [...tabs]
    }
    tabs[index] = { ...tab, isActive }
    changed = true
  }
  return changed ? { ...snapshot, activeTabId, activeTabType, tabs } : snapshot
}

export function selectMobileSessionTab(
  snapshot: RuntimeMobileSessionTabsSnapshot,
  active: RuntimeMobileSessionSnapshotTab | null
): RuntimeMobileSessionTabsSnapshot {
  const orderId = active?.type === 'terminal' ? active.parentTabId : active?.id
  const owner = snapshot.tabGroups?.find((group) =>
    group.tabOrder.some(
      (id) => id === orderId || (active?.type === 'browser' && id === active.browserWorkspaceId)
    )
  )
  const selectedId =
    active?.type === 'browser' && owner && !owner.tabOrder.includes(active.id)
      ? active.browserWorkspaceId
      : orderId
  return normalizeMobileSessionTabSelection({
    ...snapshot,
    activeGroupId: owner?.id ?? snapshot.activeGroupId,
    activeTabId: active?.id ?? null,
    activeTabType: active?.type ?? null,
    ...(snapshot.tabGroups !== undefined
      ? {
          tabGroups: snapshot.tabGroups.map((group) =>
            group === owner || (!active && group.id === snapshot.activeGroupId)
              ? { ...group, activeTabId: selectedId ?? null }
              : group
          )
        }
      : {})
  })
}

/** Only proven removal can replace navigation; absent inventory alone cannot. */
export function retireMobileSessionTabSelection(
  snapshot: RuntimeMobileSessionTabsSnapshot,
  tabs: RuntimeMobileSessionSnapshotTab[],
  removedIds: ReadonlySet<string>
): RuntimeMobileSessionTabsSnapshot {
  const live = new Set<string>()
  for (const tab of tabs) {
    live.add(tab.id)
    if (tab.type === 'terminal') {
      live.add(tab.parentTabId)
    }
    if (tab.type === 'browser') {
      live.add(tab.browserWorkspaceId)
    }
  }
  const retired = new Set([...removedIds].filter((id) => !live.has(id)))
  for (const tab of snapshot.tabs) {
    if (!removedIds.has(tab.id)) {
      continue
    }
    if (tab.type === 'terminal' && !live.has(tab.parentTabId)) {
      retired.add(tab.parentTabId)
    }
    if (tab.type === 'browser' && !live.has(tab.browserWorkspaceId)) {
      retired.add(tab.browserWorkspaceId)
    }
  }
  const selected =
    snapshot.tabGroups !== undefined
      ? snapshot.tabGroups.find((group) => group.id === snapshot.activeGroupId)?.activeTabId
      : snapshot.activeTabId
  const next = {
    ...snapshot,
    tabs,
    ...(snapshot.tabGroups !== undefined
      ? {
          tabGroups: snapshot.tabGroups.map((group) => ({
            ...group,
            tabOrder: group.tabOrder.filter((id) => !retired.has(id)),
            activeTabId:
              group.activeTabId && retired.has(group.activeTabId) ? null : group.activeTabId,
            ...(group.recentTabIds
              ? { recentTabIds: group.recentTabIds.filter((id) => !retired.has(id)) }
              : {})
          }))
        }
      : {})
  }
  return selected && retired.has(selected)
    ? selectMobileSessionTab(next, tabs.find((tab) => tab.isActive) ?? tabs[0] ?? null)
    : normalizeMobileSessionTabSelection(next)
}

/** Reconstructing membership must retain navigation from a group-less publication. */
export function restoreLegacyMobileSessionNavigation(
  snapshot: RuntimeMobileSessionTabsSnapshot,
  legacy: RuntimeMobileSessionTabsSnapshot
): RuntimeMobileSessionTabsSnapshot {
  const selectedId =
    legacy.activeTabId ?? resolveMobileSessionActiveTab(legacy, legacy.tabs)?.id ?? null
  const declaration = { ...legacy, activeTabId: selectedId }
  const active = selectedId ? resolveMobileSessionActiveTab(declaration, snapshot.tabs) : null
  if (active || !selectedId) {
    return selectMobileSessionTab(snapshot, active)
  }
  return normalizeMobileSessionTabSelection(
    preserveLegacyPendingNavigation(
      {
        ...snapshot,
        activeGroupId: legacy.activeGroupId,
        activeTabId: selectedId,
        tabGroups: undefined
      },
      snapshot
    )
  )
}

// Legacy frames have no separate navigation field once unavailable top-level selection becomes null.
export function preserveLegacyPendingNavigation(
  snapshot: RuntimeMobileSessionTabsSnapshot,
  existing: RuntimeMobileSessionTabsSnapshot | undefined
): RuntimeMobileSessionTabsSnapshot {
  if (
    snapshot.tabGroups !== undefined ||
    !snapshot.activeTabId ||
    resolveMobileSessionActiveTab(snapshot, snapshot.tabs)
  ) {
    return snapshot
  }
  const pendingId = snapshot.activeTabId
  const groups = existing?.tabGroups ?? []
  const prior =
    groups.find((group) => group.tabOrder.includes(pendingId)) ??
    groups.find((group) => group.id === snapshot.activeGroupId) ??
    groups[0]
  const id =
    prior?.id ?? snapshot.activeGroupId ?? getHeadlessMobileSessionGroupId(snapshot.worktree)
  const selected = {
    ...prior,
    id,
    activeTabId: snapshot.activeTabId,
    tabOrder: prior?.tabOrder.includes(snapshot.activeTabId)
      ? prior.tabOrder
      : [...(prior?.tabOrder ?? []), snapshot.activeTabId]
  }
  return {
    ...snapshot,
    activeGroupId: id,
    tabGroups: prior ? groups.map((group) => (group === prior ? selected : group)) : [selected]
  }
}
