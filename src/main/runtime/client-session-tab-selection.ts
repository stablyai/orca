import type {
  RuntimeMobileSessionClientTab,
  RuntimeMobileSessionTabsResult
} from '../../shared/runtime-types'

export type ClientSessionTabSelection = {
  activeTabId: string | null
  activeGroupId: string | null
  activeTabIdByGroupId: Readonly<Record<string, string>>
}

type StoredClientSessionTabSelection = {
  selection: ClientSessionTabSelection
  revision: number
}

function emptyClientSessionTabSelection(): ClientSessionTabSelection {
  return { activeTabId: null, activeGroupId: null, activeTabIdByGroupId: {} }
}

function topLevelTabId(tab: RuntimeMobileSessionClientTab): string {
  if (tab.type === 'terminal') {
    return tab.parentTabId
  }
  return tab.id
}

function findTabByTopLevelId(
  snapshot: RuntimeMobileSessionTabsResult,
  topLevelId: string | null | undefined
): RuntimeMobileSessionClientTab | null {
  if (!topLevelId) {
    return null
  }
  return snapshot.tabs.find((tab) => topLevelTabId(tab) === topLevelId) ?? null
}

export function deriveClientSessionTabSelection(
  snapshot: RuntimeMobileSessionTabsResult
): ClientSessionTabSelection {
  return {
    activeTabId: snapshot.activeTabId,
    activeGroupId: snapshot.activeGroupId,
    activeTabIdByGroupId: Object.fromEntries(
      snapshot.tabGroups?.flatMap((group) =>
        group.activeTabId ? [[group.id, group.activeTabId] as const] : []
      ) ?? []
    )
  }
}

export function activateClientSessionTabSelection(
  snapshot: RuntimeMobileSessionTabsResult,
  selection: ClientSessionTabSelection,
  activeTabId: string
): ClientSessionTabSelection {
  const activeTab = snapshot.tabs.find((tab) => tab.id === activeTabId)
  if (!activeTab) {
    return selection
  }
  const activeTopLevelTabId = topLevelTabId(activeTab)
  const activeGroup = snapshot.tabGroups?.find((group) =>
    group.tabOrder.includes(activeTopLevelTabId)
  )
  return {
    activeTabId,
    activeGroupId: activeGroup?.id ?? selection.activeGroupId,
    activeTabIdByGroupId: activeGroup
      ? { ...selection.activeTabIdByGroupId, [activeGroup.id]: activeTopLevelTabId }
      : selection.activeTabIdByGroupId
  }
}

export function projectClientSessionTabSelection(
  snapshot: RuntimeMobileSessionTabsResult,
  selection: ClientSessionTabSelection
): { snapshot: RuntimeMobileSessionTabsResult; selection: ClientSessionTabSelection } {
  const selectedGroup = snapshot.tabGroups?.find((group) => group.id === selection.activeGroupId)
  // Why: preserve the client's leaf and group choices before falling back to shared snapshot order.
  const activeTab =
    snapshot.tabs.find((tab) => tab.id === selection.activeTabId) ??
    findTabByTopLevelId(
      snapshot,
      selectedGroup ? selection.activeTabIdByGroupId[selectedGroup.id] : null
    ) ??
    findTabByTopLevelId(snapshot, selectedGroup?.tabOrder[0]) ??
    snapshot.tabs[0] ??
    null
  const activeTopLevelTabId = activeTab ? topLevelTabId(activeTab) : null
  const activeTabIdByGroupId: Record<string, string> = {}
  const tabGroups = snapshot.tabGroups?.map((group) => {
    const selected = selection.activeTabIdByGroupId[group.id]
    const activeTabId =
      (selected && group.tabOrder.includes(selected) ? selected : null) ?? group.tabOrder[0] ?? null
    if (activeTabId) {
      activeTabIdByGroupId[group.id] = activeTabId
    }
    return { ...group, activeTabId }
  })
  const activeGroupId =
    tabGroups?.find((group) =>
      activeTopLevelTabId ? group.tabOrder.includes(activeTopLevelTabId) : false
    )?.id ??
    (selection.activeGroupId && tabGroups?.some((group) => group.id === selection.activeGroupId)
      ? selection.activeGroupId
      : null) ??
    tabGroups?.[0]?.id ??
    null
  const nextSelection: ClientSessionTabSelection = {
    activeTabId: activeTab?.id ?? null,
    activeGroupId,
    activeTabIdByGroupId
  }
  return {
    selection: nextSelection,
    snapshot: {
      ...snapshot,
      activeGroupId,
      activeTabId: activeTab?.id ?? null,
      activeTabType: activeTab?.type ?? null,
      ...(tabGroups ? { tabGroups } : {}),
      tabs: snapshot.tabs.map((tab) => ({ ...tab, isActive: tab.id === activeTab?.id }))
    }
  }
}

export class ClientSessionTabSelectionStore {
  private statesByClient = new Map<string, Map<string, StoredClientSessionTabSelection>>()

  private getStatesByWorktree(
    clientNavigationId: string
  ): Map<string, StoredClientSessionTabSelection> {
    let statesByWorktree = this.statesByClient.get(clientNavigationId)
    if (!statesByWorktree) {
      statesByWorktree = new Map()
      this.statesByClient.set(clientNavigationId, statesByWorktree)
    }
    return statesByWorktree
  }

  project(
    snapshot: RuntimeMobileSessionTabsResult,
    clientNavigationId?: string
  ): RuntimeMobileSessionTabsResult {
    if (!clientNavigationId) {
      return snapshot
    }
    const statesByWorktree = this.getStatesByWorktree(clientNavigationId)
    const state = statesByWorktree.get(snapshot.worktree) ?? {
      // Why: host focus is private navigation; a new paired device starts from deterministic topology instead of inheriting it.
      selection: emptyClientSessionTabSelection(),
      revision: 0
    }
    const projected = projectClientSessionTabSelection(snapshot, state.selection)
    statesByWorktree.set(snapshot.worktree, {
      selection: projected.selection,
      revision: state.revision
    })
    return {
      ...projected.snapshot,
      publicationEpoch: `${snapshot.publicationEpoch}:client-navigation`,
      snapshotVersion: snapshot.snapshotVersion + state.revision
    }
  }

  activate(
    snapshot: RuntimeMobileSessionTabsResult,
    clientNavigationId: string,
    activeTabId: string
  ): RuntimeMobileSessionTabsResult {
    const statesByWorktree = this.getStatesByWorktree(clientNavigationId)
    const state = statesByWorktree.get(snapshot.worktree) ?? {
      selection: emptyClientSessionTabSelection(),
      revision: 0
    }
    statesByWorktree.set(snapshot.worktree, {
      selection: activateClientSessionTabSelection(snapshot, state.selection, activeTabId),
      revision: state.revision + 1
    })
    return this.project(snapshot, clientNavigationId)
  }

  forgetClient(clientNavigationId: string): void {
    this.statesByClient.delete(clientNavigationId)
  }

  forgetWorktree(worktreeId: string): void {
    for (const [clientNavigationId, statesByWorktree] of this.statesByClient) {
      statesByWorktree.delete(worktreeId)
      if (statesByWorktree.size === 0) {
        this.statesByClient.delete(clientNavigationId)
      }
    }
  }
}
