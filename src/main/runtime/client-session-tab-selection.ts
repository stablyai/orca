import {
  CLIENT_NAVIGATION_PUBLICATION_EPOCH_SUFFIX,
  type RuntimeMobileSessionTabsResult
} from '../../shared/runtime-types'
import type { PersistedMobileClientTabSelections } from '../../shared/persisted-state-types'
import {
  forgetClosedClientSessionTabsByWorktree,
  projectWithoutClosedClientSessionTabs
} from './client-session-tab-closed-selection'
import type { StoredClientSessionTabSelection } from './client-session-tab-closed-selection'
import { normalizePersistedMobileClientTabSelections } from './client-session-tab-selection-persistence'
import {
  deriveClientSessionTabSelection,
  emptyClientSessionTabSelection,
  projectClientSessionTabSelection,
  activateClientSessionTabSelection,
  topLevelTabId,
  type ClientSessionTabSelection
} from './client-session-tab-selection-projection'

export class ClientSessionTabSelectionStore {
  private statesByClient = new Map<string, Map<string, StoredClientSessionTabSelection>>()
  private persistListener: ((state: PersistedMobileClientTabSelections) => void) | null = null

  // Persist across host restart so phones do not snap back to the first tab.
  hydrate(persisted: PersistedMobileClientTabSelections): void {
    for (const [clientNavigationId, selectionsByWorktree] of Object.entries(
      normalizePersistedMobileClientTabSelections(persisted)
    )) {
      const statesByWorktree = this.getStatesByWorktree(clientNavigationId)
      for (const [worktreeId, selection] of Object.entries(selectionsByWorktree)) {
        statesByWorktree.set(worktreeId, {
          selection,
          revision: 0,
          shouldPersist: true,
          closedTabIds: new Set()
        })
      }
    }
  }

  setPersistListener(listener: (state: PersistedMobileClientTabSelections) => void): void {
    this.persistListener = listener
  }

  serialize(): PersistedMobileClientTabSelections {
    const persisted: PersistedMobileClientTabSelections = {}
    for (const [clientNavigationId, statesByWorktree] of this.statesByClient) {
      const entries: Record<string, ClientSessionTabSelection> = {}
      for (const [worktreeId, state] of statesByWorktree) {
        if (state.shouldPersist) {
          entries[worktreeId] = state.selection
        }
      }
      if (Object.keys(entries).length > 0) {
        persisted[clientNavigationId] = entries
      }
    }
    return persisted
  }

  private persistNow(): void {
    this.persistListener?.(this.serialize())
  }

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
    const existingState = statesByWorktree.get(snapshot.worktree)
    const state = existingState ?? {
      selection: emptyClientSessionTabSelection(),
      revision: 0,
      shouldPersist: false,
      closedTabIds: new Set<string>()
    }
    const closed = projectWithoutClosedClientSessionTabs(snapshot, state.closedTabIds)
    if (closed.snapshot.tabs.length === 0) {
      if (existingState) {
        statesByWorktree.set(snapshot.worktree, {
          ...state,
          closedTabIds: closed.retainedClosedTabIds
        })
      }
      // Empty startup topology must not erase hydrated selections.
      return {
        ...closed.snapshot,
        publicationEpoch: `${snapshot.publicationEpoch}${CLIENT_NAVIGATION_PUBLICATION_EPOCH_SUFFIX}`,
        snapshotVersion: snapshot.snapshotVersion + state.revision
      }
    }
    // Follow the host until this device first picks a tab; never move it mid-visit.
    const selection = state.shouldPersist
      ? state.selection
      : deriveClientSessionTabSelection(closed.snapshot)
    const projected = projectClientSessionTabSelection(
      closed.snapshot,
      selection,
      state.topologyBeforeClose
    )
    // Guest swaps briefly omit tabs; do not overwrite the explicit pick with a persistent fallback.
    const selectionSurvived =
      !selection.activeTabId || closed.snapshot.tabs.some((tab) => tab.id === selection.activeTabId)
    statesByWorktree.set(snapshot.worktree, {
      selection: selectionSurvived ? projected.selection : selection,
      revision: state.revision,
      shouldPersist: state.shouldPersist,
      closedTabIds: closed.retainedClosedTabIds,
      // Freeze missing-pick topology so close fallback remains stable across snapshots.
      topologyBeforeClose: selectionSurvived
        ? { tabGroups: closed.snapshot.tabGroups, tabGroupLayout: closed.snapshot.tabGroupLayout }
        : state.topologyBeforeClose
    })
    return {
      ...projected.snapshot,
      publicationEpoch: `${snapshot.publicationEpoch}${CLIENT_NAVIGATION_PUBLICATION_EPOCH_SUFFIX}`,
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
      revision: 0,
      shouldPersist: false,
      closedTabIds: new Set<string>()
    }
    const nextSelection = activateClientSessionTabSelection(snapshot, state.selection, activeTabId)
    const activeTab = snapshot.tabs.find((tab) => tab.id === activeTabId)
    const closedTabIds = new Set(state.closedTabIds)
    closedTabIds.delete(activeTabId)
    if (activeTab) {
      closedTabIds.delete(topLevelTabId(activeTab))
    }
    statesByWorktree.set(snapshot.worktree, {
      ...state,
      selection: nextSelection,
      revision: state.revision + 1,
      shouldPersist: true,
      closedTabIds
    })
    this.persistNow()
    return this.project(snapshot, clientNavigationId)
  }

  forgetTabs(worktreeId: string, tabIds: readonly string[]): void {
    if (tabIds.length === 0) {
      return
    }
    if (forgetClosedClientSessionTabsByWorktree(this.statesByClient, worktreeId, tabIds)) {
      this.persistNow()
    }
  }

  forgetClient(clientNavigationId: string): void {
    const statesByWorktree = this.statesByClient.get(clientNavigationId)
    const hadPersistedState = [...(statesByWorktree?.values() ?? [])].some(
      (state) => state.shouldPersist
    )
    if (this.statesByClient.delete(clientNavigationId) && hadPersistedState) {
      this.persistNow()
    }
  }

  migrateWorktree(oldWorktreeId: string, newWorktreeId: string): void {
    if (oldWorktreeId === newWorktreeId) {
      return
    }
    let changed = false
    for (const statesByWorktree of this.statesByClient.values()) {
      const state = statesByWorktree.get(oldWorktreeId)
      if (!state) {
        continue
      }
      statesByWorktree.set(newWorktreeId, state)
      statesByWorktree.delete(oldWorktreeId)
      changed = state.shouldPersist || changed
    }
    if (changed) {
      this.persistNow()
    }
  }

  forgetWorktree(worktreeId: string): void {
    let changed = false
    for (const [clientNavigationId, statesByWorktree] of this.statesByClient) {
      const state = statesByWorktree.get(worktreeId)
      changed = Boolean(state?.shouldPersist) || changed
      statesByWorktree.delete(worktreeId)
      if (statesByWorktree.size === 0) {
        this.statesByClient.delete(clientNavigationId)
      }
    }
    if (changed) {
      this.persistNow()
    }
  }
}
