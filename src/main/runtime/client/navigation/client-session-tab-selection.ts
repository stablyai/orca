import {
  CLIENT_NAVIGATION_PUBLICATION_EPOCH_SUFFIX,
  type RuntimeMobileSessionTabsResult
} from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { PersistedMobileClientTabSelections } from '../../../../shared/orca-profiles/persisted-state-types'
import {
  forgetClosedClientSessionTabsByWorktree,
  projectWithoutClosedClientSessionTabs
} from './client-session-tab-closed-selection'
import type { StoredClientSessionTabSelection } from './client-session-tab-closed-selection'
import { normalizePersistedMobileClientTabSelections } from './client-session-tab-selection-persistence'
import {
  isTeammateTabList,
  TEAMMATE_MOVED_HOMES_ROW,
  type TabOwner,
  type TeammateTabListKey
} from '../../../bots/team-share/teammate-rules'
import {
  deriveClientSessionTabSelection,
  emptyClientSessionTabSelection,
  projectClientSessionTabSelection,
  activateClientSessionTabSelection,
  topLevelTabId,
  type ClientSessionTabSelection
} from './client-session-tab-selection-projection'

/** A workspace's tab list: the host's (everyone's but teammates' in their own Home), or one teammate's. */
export type SessionTabListName = 'host' | TeammateTabListKey

export function sessionTabListName(owner: TabOwner): SessionTabListName {
  return isTeammateTabList(owner) ? owner : 'host'
}

export class ClientSessionTabSelectionStore {
  private statesByClient = new Map<string, Map<string, StoredClientSessionTabSelection>>()
  private persistListener: ((state: PersistedMobileClientTabSelections) => void) | null = null
  // Whose list each client sees in a workspace (`tabOwnerOf`); a list's change touches only its clients.
  // null: not known yet (an agent's Home before the share devices load), so no bulk change touches it.
  private listOf: (clientNavigationId: string, worktreeId: string) => TabOwner | null = () =>
    'shared'

  setTabOwnerResolver(
    listOf: (clientNavigationId: string, worktreeId: string) => TabOwner | null
  ): void {
    this.listOf = listOf
  }

  private seesList(worktreeId: string, list: SessionTabListName): (client: string) => boolean {
    return (client) => {
      const owner = this.listOf(client, worktreeId)
      return owner !== null && sessionTabListName(owner) === list
    }
  }

  // Persist across host restart so phones do not snap back to the first tab.
  hydrate(persisted: PersistedMobileClientTabSelections): void {
    for (const [clientNavigationId, selectionsByWorktree] of Object.entries(
      normalizePersistedMobileClientTabSelections(persisted)
    )) {
      // A teammate's own tab list, not a device: `PersonSessionTabLists` reads it.
      if (
        isTeammateTabList(clientNavigationId) ||
        clientNavigationId === TEAMMATE_MOVED_HOMES_ROW
      ) {
        continue
      }
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
    statesByWorktree.set(snapshot.worktree, {
      ...state,
      selection: nextSelection,
      revision: state.revision + 1,
      shouldPersist: true,
      closedTabIds: this.reopenedTabIds(snapshot, state.closedTabIds, activeTabId)
    })
    this.persistNow()
    return this.project(snapshot, clientNavigationId)
  }

  private reopenedTabIds(
    snapshot: RuntimeMobileSessionTabsResult,
    previous: ReadonlySet<string>,
    tabId: string
  ): Set<string> {
    const tab = snapshot.tabs.find((candidate) => candidate.id === tabId)
    const closedTabIds = new Set(previous)
    closedTabIds.delete(tabId)
    if (tab) {
      closedTabIds.delete(topLevelTabId(tab))
    }
    return closedTabIds
  }

  reopen(
    snapshot: RuntimeMobileSessionTabsResult,
    clientNavigationId: string,
    tabId: string
  ): RuntimeMobileSessionTabsResult {
    // Establish the caller's current selection before changing visibility.
    this.project(snapshot, clientNavigationId)
    const states = this.getStatesByWorktree(clientNavigationId)
    const state = states.get(snapshot.worktree)
    if (state) {
      states.set(snapshot.worktree, {
        ...state,
        revision: state.revision + 1,
        closedTabIds: this.reopenedTabIds(snapshot, state.closedTabIds, tabId)
      })
    }
    return this.project(snapshot, clientNavigationId)
  }

  /** The host published this tab again (a chat keeps its id), so no client may keep hiding it. */
  reopenForAllClients(worktreeId: string, tabId: string, list: SessionTabListName = 'host'): void {
    const sees = this.seesList(worktreeId, list)
    for (const [clientNavigationId, statesByWorktree] of this.statesByClient) {
      if (!sees(clientNavigationId)) {
        continue
      }
      const state = statesByWorktree.get(worktreeId)
      if (!state?.closedTabIds.has(tabId)) {
        continue
      }
      const closedTabIds = new Set(state.closedTabIds)
      closedTabIds.delete(tabId)
      statesByWorktree.set(worktreeId, { ...state, revision: state.revision + 1, closedTabIds })
    }
  }

  forgetTabs(
    worktreeId: string,
    tabIds: readonly string[],
    list: SessionTabListName = 'host'
  ): void {
    if (tabIds.length === 0) {
      return
    }
    const sees = this.seesList(worktreeId, list)
    if (forgetClosedClientSessionTabsByWorktree(this.statesByClient, worktreeId, tabIds, sees)) {
      this.persistNow()
    }
  }

  /** After a close: every client of the list (offline ones too) moves its pick by the close rule now,
   *  so none returns to the closed tab when it opens again. */
  settleClosedTabs(snapshot: RuntimeMobileSessionTabsResult, list: SessionTabListName): void {
    const sees = this.seesList(snapshot.worktree, list)
    for (const [clientNavigationId, statesByWorktree] of this.statesByClient) {
      const state = statesByWorktree.get(snapshot.worktree)
      if (!state || !sees(clientNavigationId)) {
        continue
      }
      if (snapshot.tabs.length === 0) {
        // Nothing is left to hide, so a tab that opens here again shows on every device.
        statesByWorktree.set(snapshot.worktree, {
          ...state,
          selection: emptyClientSessionTabSelection(),
          closedTabIds: new Set(),
          revision: state.revision + 1
        })
      } else {
        this.project(snapshot, clientNavigationId)
      }
    }
    this.persistNow()
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

  forgetWorktree(worktreeId: string, list: SessionTabListName = 'host'): void {
    const sees = this.seesList(worktreeId, list)
    let changed = false
    for (const [clientNavigationId, statesByWorktree] of this.statesByClient) {
      if (!sees(clientNavigationId)) {
        continue
      }
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
