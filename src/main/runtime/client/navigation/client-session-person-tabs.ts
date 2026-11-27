// A teammate's own chat tabs on a shared agent's host: one set per person, shown on every device of
// theirs and never written into the host's tab list, which belongs to the owner's screens.
import type { RuntimeMobileSessionAgentTab } from '../../../../shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { getHeadlessMobileSessionGroupId } from '../../terminal/surface/mobile-session-layout-projection'
import type { StoredClientSessionTabSelection } from './client-session-tab-closed-selection'
import { emptyClientSessionTabSelection } from './client-session-tab-selection-projection'

/** The teammate a paired device calls for; null for the owner's devices. */
export type ClientSessionPerson = {
  /** Their tab set's key: the share, by bot and account (`teammateTabSetKey`). */
  key: string
  /** The shared agent's home, the one workspace whose tabs are each person's own. */
  home: string
  /** The host's home tabs this person is listed: their own chats'. */
  hostTabs(snapshot: RuntimeMobileSessionTabsResult): RuntimeMobileSessionTabsResult
}

export type ClientSessionPeople = {
  personOf(clientNavigationId: string): ClientSessionPerson | null
  /** The chat's tab while it is still in that workspace, else null. */
  tabOf(
    worktreeId: string,
    sessionId: string
  ): Pick<RuntimeMobileSessionAgentTab, 'title' | 'agent'> | null
}

/** The person key a teammate's tab set is kept under: the share, by bot and account. */
export function teammateTabSetKey(grant: { botId: string; accountId: string }): string {
  return `teammate:${JSON.stringify([grant.botId, grant.accountId])}`
}

export function personSessionTabId(sessionId: string): string {
  return `agent-session:${sessionId}`
}

/** The person's chats in this workspace added to its tabs, after the host's own (a chat the host
 *  also has a tab for shows once, as the host's). */
export function withPersonSessionTabs(
  snapshot: RuntimeMobileSessionTabsResult,
  sessionIds: readonly string[],
  people: ClientSessionPeople
): RuntimeMobileSessionTabsResult {
  const shown = new Set(
    snapshot.tabs.flatMap((tab) => (tab.type === 'agent-session' ? [tab.sessionId] : []))
  )
  const added = sessionIds.flatMap((sessionId): RuntimeMobileSessionAgentTab[] => {
    const tab = shown.has(sessionId) ? null : people.tabOf(snapshot.worktree, sessionId)
    return tab
      ? [
          {
            type: 'agent-session',
            id: personSessionTabId(sessionId),
            sessionId,
            isActive: false,
            ...tab
          }
        ]
      : []
  })
  if (added.length === 0) {
    return snapshot
  }
  const ids = added.map((tab) => tab.id)
  const groups = snapshot.tabGroups?.length
    ? snapshot.tabGroups
    : [{ id: getHeadlessMobileSessionGroupId(snapshot.worktree), activeTabId: null, tabOrder: [] }]
  const groupId = groups.some((group) => group.id === snapshot.activeGroupId)
    ? snapshot.activeGroupId
    : groups[0]!.id
  return {
    ...snapshot,
    activeGroupId: snapshot.activeGroupId ?? groupId,
    tabs: [...snapshot.tabs, ...added],
    tabGroups: groups.map((group) =>
      group.id === groupId ? { ...group, tabOrder: [...group.tabOrder, ...ids] } : group
    )
  }
}

/** The person tab sets inside the client tab store: kept under each person's key in its states, so
 *  they persist, migrate and are forgotten with the devices' selections. */
export class ClientSessionPersonTabs {
  private people: ClientSessionPeople | null = null

  constructor(
    private readonly statesByClient: Map<string, Map<string, StoredClientSessionTabSelection>>,
    private readonly persist: () => void
  ) {}

  setPeople(people: ClientSessionPeople): ClientSessionPeople {
    this.people = people
    return people
  }

  /** The person a device calls for, when this workspace is their agent's home. */
  private homePerson(clientNavigationId: string, worktreeId: string) {
    const person = this.people?.personOf(clientNavigationId)
    return person?.home === worktreeId ? person : null
  }

  private stateOf(person: string, worktreeId: string) {
    return this.statesByClient.get(person)?.get(worktreeId)
  }

  /** What a device is shown of a workspace: the host's tabs as listed to it, then its person's own,
   *  versioned past every change to either. The owner's devices see the host's tabs as they are. */
  shown(
    snapshot: RuntimeMobileSessionTabsResult,
    clientNavigationId: string
  ): RuntimeMobileSessionTabsResult {
    const person = this.homePerson(clientNavigationId, snapshot.worktree)
    if (!person || !this.people) {
      return snapshot
    }
    const state = this.stateOf(person.key, snapshot.worktree)
    const shown = withPersonSessionTabs(
      person.hostTabs(snapshot),
      state?.personTabs ?? [],
      this.people
    )
    return { ...shown, snapshotVersion: shown.snapshotVersion + (state?.revision ?? 0) }
  }

  /** The caller's person's own tab by its id, if it is one of theirs. */
  ownTab(
    clientNavigationId: string | undefined,
    worktreeId: string,
    tabId: string
  ): RuntimeMobileSessionAgentTab | undefined {
    const person = clientNavigationId ? this.homePerson(clientNavigationId, worktreeId) : null
    const sessionId = person
      ? this.stateOf(person.key, worktreeId)?.personTabs?.find(
          (id) => personSessionTabId(id) === tabId
        )
      : undefined
    const tab = sessionId ? this.people?.tabOf(worktreeId, sessionId) : null
    return sessionId && tab
      ? { type: 'agent-session', id: tabId, sessionId, isActive: false, ...tab }
      : undefined
  }

  /** The host's snapshots, and an `empty` one for the agent's home when the host lists none there
   *  and the device's person has tabs of their own in it. */
  withOwnWorkspaces<S extends { worktree: string }>(
    snapshots: S[],
    clientNavigationId: string | undefined,
    empty: (worktreeId: string) => S
  ): S[] {
    const person = clientNavigationId ? this.people?.personOf(clientNavigationId) : null
    const own = person ? this.stateOf(person.key, person.home)?.personTabs : undefined
    return person && own?.length && !snapshots.some((s) => s.worktree === person.home)
      ? [...snapshots, empty(person.home)]
      : snapshots
  }

  /** Adds a chat to the caller's person's own tabs; false when the tab is not theirs to hold (the
   *  owner's devices, or any workspace but the agent's home), so it goes in the host's list. */
  open(clientNavigationId: string, worktreeId: string, sessionId: string): boolean {
    const person = this.homePerson(clientNavigationId, worktreeId)
    if (person) {
      this.add(person.key, worktreeId, sessionId)
    }
    return person !== null
  }

  /** Adds a chat to a person's own tabs by their person key. */
  add(person: string, worktreeId: string, sessionId: string): void {
    this.put(person, worktreeId, (tabs) => (tabs.includes(sessionId) ? tabs : [...tabs, sessionId]))
  }

  /** Drops a chat tab from the caller's person's own tabs, and from each of their devices' picks;
   *  false when it was not one of them. */
  close(clientNavigationId: string, worktreeId: string, tabId: string): boolean {
    const person = this.homePerson(clientNavigationId, worktreeId)
    const tabs = person ? this.stateOf(person.key, worktreeId)?.personTabs : undefined
    if (!person || !tabs?.some((id) => personSessionTabId(id) === tabId)) {
      return false
    }
    this.put(person.key, worktreeId, (current) =>
      current.filter((id) => personSessionTabId(id) !== tabId)
    )
    for (const [clientNavigationId, statesByWorktree] of this.statesByClient) {
      const device = statesByWorktree.get(worktreeId)
      if (
        device?.selection.activeTabId === tabId &&
        this.people?.personOf(clientNavigationId)?.key === person.key
      ) {
        statesByWorktree.set(worktreeId, {
          ...device,
          selection: { ...device.selection, activeTabId: null }
        })
      }
    }
    return true
  }

  /** Moves the person's tab set; its revision versions every device's frame of the workspace. */
  private put(
    person: string,
    worktreeId: string,
    next: (tabs: readonly string[]) => readonly string[]
  ): void {
    let states = this.statesByClient.get(person)
    if (!states) {
      states = new Map()
      this.statesByClient.set(person, states)
    }
    const state = states.get(worktreeId) ?? {
      selection: emptyClientSessionTabSelection(),
      revision: 0,
      shouldPersist: true,
      closedTabIds: new Set<string>()
    }
    states.set(worktreeId, {
      ...state,
      revision: state.revision + 1,
      shouldPersist: true,
      personTabs: next(state.personTabs ?? [])
    })
    this.persist()
  }
}
