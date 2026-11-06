import type { RuntimeMobileSessionSnapshotTab } from '../../../shared/runtime-mobile-session-tab-contracts'
import type { RuntimeMobileSessionTabGroup } from '../../../shared/runtime-session-contracts'

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
  const declared =
    snapshot.tabGroups?.find((group) => group.id === snapshot.activeGroupId)?.activeTabId ??
    snapshot.activeTabId
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
