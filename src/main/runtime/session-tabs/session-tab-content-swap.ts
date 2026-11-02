import type {
  RuntimeMobileSessionAgentTab,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab
} from '../../../shared/runtime-types'
import type { TabContentRef } from '../../../shared/workspace-layout/workspace-layout-tab-content'
import { logicalTabIdOf, tabBarIdOf } from '../../../shared/runtime-mobile-session-tab-contracts'

type ContentRow = RuntimeMobileSessionTerminalTab | RuntimeMobileSessionAgentTab

/**
 * Main's own write of a switch's destination before the layout owner's next frame: the tab's
 * rows become the new row in their place, under the same layout id, in the same group order slot,
 * active only if the tab was. A tab this snapshot doesn't list yet gets no row here; the layout
 * owner's frame brings it.
 */
export function swapSessionTabContent(
  existing: RuntimeMobileSessionTabsSnapshot | undefined,
  logicalTabId: string,
  row: ContentRow
): RuntimeMobileSessionTabsSnapshot | null {
  const at = existing?.tabs.findIndex((candidate) => logicalTabIdOf(candidate) === logicalTabId)
  if (!existing || at === undefined || at < 0) {
    return null
  }
  const oldTabBarId = tabBarIdOf(existing.tabs[at]!)
  const wasActive = existing.tabs.some(
    (candidate) => logicalTabIdOf(candidate) === logicalTabId && candidate.isActive
  )
  const swapped: ContentRow = { ...row, isActive: wasActive }
  const newTabBarId = tabBarIdOf(swapped)
  const tabs = existing.tabs.flatMap((candidate, index) =>
    index === at
      ? [swapped]
      : logicalTabIdOf(candidate) === logicalTabId || candidate.id === swapped.id
        ? []
        : [candidate]
  )
  const rename = (id: string | null | undefined) => (id === oldTabBarId ? newTabBarId : id)
  return {
    ...existing,
    snapshotVersion: existing.snapshotVersion + 1,
    activeTabId: wasActive ? swapped.id : existing.activeTabId,
    activeTabType: wasActive ? swapped.type : existing.activeTabType,
    tabGroups: existing.tabGroups?.map((group) => ({
      ...group,
      tabOrder: group.tabOrder.map((id) => rename(id)!),
      activeTabId: rename(group.activeTabId) ?? null,
      ...(group.recentTabIds ? { recentTabIds: group.recentTabIds.map((id) => rename(id)!) } : {})
    })),
    tabs
  }
}

/** The layout id of the tab the published snapshot shows holding this terminal or chat: every
 *  layout owner publishes it, so main reads the window's tab ids here too. */
export function logicalTabHolding(
  snapshot: RuntimeMobileSessionTabsSnapshot | undefined,
  content: TabContentRef
): string | undefined {
  const row = snapshot?.tabs.find((candidate) =>
    content.kind === 'terminal'
      ? candidate.type === 'terminal' && candidate.parentTabId === content.terminalId
      : candidate.type === 'agent-session' && candidate.sessionId === content.sessionId
  )
  return row && logicalTabIdOf(row)
}
