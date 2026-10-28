import type {
  RuntimeMobileSessionClientTab,
  RuntimeMobileSessionTabsResult
} from '../../shared/runtime-types'
import type {
  ClientSessionTabSelection,
  ClientSessionTabTopology
} from './client-session-tab-selection-projection'

export type StoredClientSessionTabSelection = {
  selection: ClientSessionTabSelection
  revision: number
  shouldPersist: boolean
  closedTabIds: ReadonlySet<string>
  /** What this client was shown while its pick was still there; not persisted. */
  topologyBeforeClose?: ClientSessionTabTopology
}

function topLevelTabId(tab: RuntimeMobileSessionClientTab): string {
  return tab.type === 'terminal' ? tab.parentTabId : tab.id
}

export function projectWithoutClosedClientSessionTabs(
  snapshot: RuntimeMobileSessionTabsResult,
  closedTabIds: ReadonlySet<string>
): { snapshot: RuntimeMobileSessionTabsResult; retainedClosedTabIds: ReadonlySet<string> } {
  if (closedTabIds.size === 0) {
    return { snapshot, retainedClosedTabIds: closedTabIds }
  }
  const presentTabIds = new Set(snapshot.tabs.flatMap((tab) => [tab.id, topLevelTabId(tab)]))
  const retainedClosedTabIds = new Set(
    [...closedTabIds].filter((tabId) => presentTabIds.has(tabId))
  )
  if (retainedClosedTabIds.size === 0) {
    return { snapshot, retainedClosedTabIds }
  }
  const tabs = snapshot.tabs.filter(
    (tab) => !retainedClosedTabIds.has(tab.id) && !retainedClosedTabIds.has(topLevelTabId(tab))
  )
  const tabGroups = snapshot.tabGroups?.map((group) => {
    const tabOrder = group.tabOrder.filter((tabId) => !retainedClosedTabIds.has(tabId))
    return {
      ...group,
      tabOrder,
      activeTabId:
        group.activeTabId && tabOrder.includes(group.activeTabId) ? group.activeTabId : null
    }
  })
  return {
    snapshot: { ...snapshot, tabs, ...(tabGroups ? { tabGroups } : {}) },
    retainedClosedTabIds
  }
}

export function forgetClosedClientSessionSelection(
  selection: ClientSessionTabSelection,
  existingClosedTabIds: ReadonlySet<string>,
  tabIds: readonly string[]
): {
  selection: ClientSessionTabSelection
  closedTabIds: ReadonlySet<string>
  selectionChanged: boolean
  closureChanged: boolean
} {
  const forgotten = new Set(tabIds)
  const closedTabIds = new Set([...existingClosedTabIds, ...forgotten])
  const activeTabId =
    selection.activeTabId && forgotten.has(selection.activeTabId) ? null : selection.activeTabId
  // Why: the group picks stay so the next projection moves them by the close rule.
  return {
    selection: { ...selection, activeTabId },
    closedTabIds,
    selectionChanged: activeTabId !== selection.activeTabId,
    closureChanged: closedTabIds.size !== existingClosedTabIds.size
  }
}

export function forgetClosedClientSessionTabsByWorktree(
  statesByClient: ReadonlyMap<string, Map<string, StoredClientSessionTabSelection>>,
  worktreeId: string,
  tabIds: readonly string[]
): boolean {
  let persistedSelectionChanged = false
  for (const statesByWorktree of statesByClient.values()) {
    const state = statesByWorktree.get(worktreeId)
    if (!state) {
      continue
    }
    const closed = forgetClosedClientSessionSelection(state.selection, state.closedTabIds, tabIds)
    if (!closed.selectionChanged && !closed.closureChanged) {
      continue
    }
    statesByWorktree.set(worktreeId, {
      ...state,
      selection: closed.selection,
      revision: state.revision + 1,
      closedTabIds: closed.closedTabIds
    })
    persistedSelectionChanged ||= state.shouldPersist && closed.selectionChanged
  }
  return persistedSelectionChanged
}
