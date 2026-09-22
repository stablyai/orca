import type { RuntimeCapability } from '../../../../shared/protocol-version'
import { BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { TabGroupLayoutNode } from '../../../../shared/tab-types'
import type {
  RuntimeMobileSessionClientTab,
  RuntimeMobileSessionTabMove,
  RuntimeMobileSessionTabGroup,
  RuntimeMobileSessionTabsResult
} from '../../../../shared/runtime-types'

export function clientCanObserveClientHostedBrowserPages(
  clientCapabilities: readonly RuntimeCapability[] | undefined
): boolean {
  return clientCapabilities?.includes(BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY) === true
}

export function projectSessionTabBrowserPlacements(
  payload: RuntimeMobileSessionTabsResult,
  clientCapabilities: readonly RuntimeCapability[] | undefined
): RuntimeMobileSessionTabsResult {
  if (clientCanObserveClientHostedBrowserPages(clientCapabilities)) {
    return payload
  }
  const removedIds = new Set(
    payload.tabs
      .filter((tab) => tab.type === 'browser' && tab.placement?.kind === 'client')
      .map((tab) => tab.id)
  )
  if (removedIds.size === 0) {
    return payload
  }
  const retainedTabs = payload.tabs.filter((tab) => !removedIds.has(tab.id))
  const active = selectProjectedActiveTab(payload.activeTabId, retainedTabs)
  const tabs = retainedTabs.map((tab) => ({ ...tab, isActive: tab.id === active?.id }))
  const tabGroups = projectTabGroups(payload.tabGroups, removedIds)
  const groupIds = new Set(tabGroups?.map((group) => group.id) ?? [])
  const activeTopLevelId = active ? topLevelTabId(active) : null
  const activeGroupId =
    payload.activeGroupId && groupIds.has(payload.activeGroupId)
      ? payload.activeGroupId
      : (tabGroups?.find((group) =>
          activeTopLevelId ? group.tabOrder.includes(activeTopLevelId) : false
        )?.id ??
        tabGroups?.[0]?.id ??
        null)
  return {
    ...payload,
    activeGroupId,
    activeTabId: active?.id ?? null,
    activeTabType: active?.type ?? null,
    ...(tabGroups ? { tabGroups } : { tabGroups: undefined }),
    ...(payload.tabGroupLayout === undefined
      ? {}
      : { tabGroupLayout: pruneTabGroupLayout(payload.tabGroupLayout, groupIds) }),
    tabs
  }
}

export function assertProjectedSessionTabVisible(
  snapshot: RuntimeMobileSessionTabsResult,
  tabId: string
): void {
  if (!resolveProjectedTopLevelTabId(snapshot, tabId)) {
    throw new Error('tab_not_found')
  }
}

export function translateProjectedSessionTabMove(
  raw: RuntimeMobileSessionTabsResult,
  projected: RuntimeMobileSessionTabsResult,
  move: RuntimeMobileSessionTabMove
): RuntimeMobileSessionTabMove {
  const tabId = resolveProjectedTopLevelTabId(projected, move.tabId)
  if (!tabId) {
    throw new Error('tab_not_found')
  }
  const visibleTarget = projected.tabGroups?.find((group) => group.id === move.targetGroupId)
  const rawTarget = raw.tabGroups?.find((group) => group.id === move.targetGroupId)
  if (!visibleTarget || !rawTarget) {
    throw new Error('target_group_not_found')
  }
  if (move.kind === 'split') {
    return { ...move, tabId }
  }
  if (move.kind === 'move-to-group') {
    return {
      ...move,
      tabId,
      ...(move.index === undefined
        ? {}
        : { index: translateProjectedInsertionIndex(rawTarget, visibleTarget, move.index) })
    }
  }
  assertExactVisibleOrder(visibleTarget.tabOrder, move.tabOrder)
  const visibleIds = new Set(visibleTarget.tabOrder)
  let visibleIndex = 0
  const tabOrder = rawTarget.tabOrder.map((rawTabId) => {
    if (!visibleIds.has(rawTabId)) {
      return rawTabId
    }
    const next = move.tabOrder[visibleIndex]
    visibleIndex += 1
    return next!
  })
  return { ...move, tabId, tabOrder }
}

function resolveProjectedTopLevelTabId(
  snapshot: RuntimeMobileSessionTabsResult,
  tabId: string
): string | null {
  const tab = snapshot.tabs.find(
    (candidate) =>
      candidate.id === tabId ||
      (candidate.type === 'terminal' && candidate.parentTabId === tabId) ||
      (candidate.type === 'browser' && candidate.browserWorkspaceId === tabId)
  )
  return tab ? topLevelTabId(tab) : null
}

function translateProjectedInsertionIndex(
  raw: RuntimeMobileSessionTabGroup,
  projected: RuntimeMobileSessionTabGroup,
  requestedIndex: number
): number {
  const index = Math.max(0, Math.min(requestedIndex, projected.tabOrder.length))
  if (index === projected.tabOrder.length) {
    return raw.tabOrder.length
  }
  const rawIndex = raw.tabOrder.indexOf(projected.tabOrder[index]!)
  if (rawIndex === -1) {
    throw new Error('invalid_tab_order')
  }
  return rawIndex
}

function assertExactVisibleOrder(current: readonly string[], requested: readonly string[]): void {
  if (
    current.length !== requested.length ||
    new Set(requested).size !== requested.length ||
    requested.some((tabId) => !current.includes(tabId))
  ) {
    throw new Error('invalid_tab_order')
  }
}

function selectProjectedActiveTab(
  activeTabId: string | null,
  tabs: readonly RuntimeMobileSessionClientTab[]
): RuntimeMobileSessionClientTab | null {
  return (
    tabs.find((tab) => tab.id === activeTabId) ??
    tabs.find((tab) => tab.isActive) ??
    tabs[0] ??
    null
  )
}

function topLevelTabId(tab: RuntimeMobileSessionClientTab): string {
  return tab.type === 'terminal' ? tab.parentTabId : tab.id
}

function projectTabGroups(
  groups: readonly RuntimeMobileSessionTabGroup[] | undefined,
  removedIds: ReadonlySet<string>
): RuntimeMobileSessionTabGroup[] | undefined {
  const projected = groups
    ?.map((group): RuntimeMobileSessionTabGroup | null => {
      const tabOrder = group.tabOrder.filter((id) => !removedIds.has(id))
      if (tabOrder.length === 0) {
        return null
      }
      return {
        ...group,
        activeTabId:
          group.activeTabId && tabOrder.includes(group.activeTabId)
            ? group.activeTabId
            : (tabOrder[0] ?? null),
        tabOrder,
        ...(group.recentTabIds
          ? { recentTabIds: group.recentTabIds.filter((id) => tabOrder.includes(id)) }
          : {})
      }
    })
    .filter((group): group is RuntimeMobileSessionTabGroup => group !== null)
  return projected && projected.length > 0 ? projected : undefined
}

function pruneTabGroupLayout(
  layout: TabGroupLayoutNode | null | undefined,
  groupIds: ReadonlySet<string>
): TabGroupLayoutNode | null {
  if (!layout) {
    return null
  }
  if (layout.type === 'leaf') {
    return groupIds.has(layout.groupId) ? layout : null
  }
  const first = pruneTabGroupLayout(layout.first, groupIds)
  const second = pruneTabGroupLayout(layout.second, groupIds)
  if (first && second) {
    return { ...layout, first, second }
  }
  return first ?? second
}
