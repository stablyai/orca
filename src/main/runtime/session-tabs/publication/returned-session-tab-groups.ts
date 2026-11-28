import type { RuntimeMobileSessionClientTab } from '../../../../shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'
import type { RuntimeMobileSessionTabGroup } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { getMobileSessionTabOrderIds } from '../../session-lifecycle/projection/mobile-session-tab-merge'

/** The ids of the tabs a frame returns, groups' members included. */
export function collectReturnedSessionTabIds(
  tabs: readonly RuntimeMobileSessionClientTab[]
): Set<string> {
  return new Set(tabs.flatMap(getMobileSessionTabOrderIds))
}

/** A frame's groups kept to the tabs it returns; a group left empty goes. */
export function sanitizeMobileSessionTabGroups(
  groups: readonly RuntimeMobileSessionTabGroup[] | undefined,
  returnedTabs: readonly RuntimeMobileSessionClientTab[]
): RuntimeMobileSessionTabGroup[] | undefined {
  if (!groups || groups.length === 0) {
    return undefined
  }
  const returnedIds = collectReturnedSessionTabIds(returnedTabs)
  const sanitized = groups
    .map((group): RuntimeMobileSessionTabGroup | null => {
      const tabOrder = group.tabOrder.filter((tabId) => returnedIds.has(tabId))
      if (tabOrder.length === 0) {
        return null
      }
      const recentTabIds = group.recentTabIds?.filter((tabId) => tabOrder.includes(tabId))
      return {
        id: group.id,
        activeTabId:
          group.activeTabId && tabOrder.includes(group.activeTabId) ? group.activeTabId : null,
        tabOrder,
        ...(recentTabIds && recentTabIds.length > 0 ? { recentTabIds } : {})
      }
    })
    .filter((group): group is RuntimeMobileSessionTabGroup => group !== null)
  return sanitized.length > 0 ? sanitized : undefined
}
