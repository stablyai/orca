// A teammate's own chat tabs on a shared agent's host: one set per person, shown on every device of
// theirs and never written into the host's tab list, which belongs to the owner's screens.
import type { RuntimeMobileSessionAgentTab } from '../../../../shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { getHeadlessMobileSessionGroupId } from '../../terminal/surface/mobile-session-layout-projection'
import type { StoredClientSessionTabSelection } from './client-session-tab-closed-selection'
import { emptyClientSessionTabSelection } from './client-session-tab-selection-projection'

/** Which person a paired device calls for, and what a chat in their set shows; null for the owner. */
export type ClientSessionPeople = {
  personOf(clientNavigationId: string): string | null
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

  private sessionIdsOf(clientNavigationId: string, worktreeId: string) {
    const person = this.people?.personOf(clientNavigationId)
    return person ? this.statesByClient.get(person)?.get(worktreeId)?.personTabs : undefined
  }

  /** The caller's person's own chats added to the host's tabs; the snapshot alone for the owner's. */
  shown(
    snapshot: RuntimeMobileSessionTabsResult,
    clientNavigationId: string
  ): RuntimeMobileSessionTabsResult {
    const sessionIds = this.sessionIdsOf(clientNavigationId, snapshot.worktree)
    return sessionIds?.length && this.people
      ? withPersonSessionTabs(snapshot, sessionIds, this.people)
      : snapshot
  }

  /** The caller's person's own tab by its id in this workspace; null when it is not one of theirs. */
  tabOf(
    clientNavigationId: string,
    worktreeId: string,
    tabId: string
  ): { id: string; sessionId: string } | null {
    const sessionId = this.sessionIdsOf(clientNavigationId, worktreeId)?.find(
      (id) => personSessionTabId(id) === tabId
    )
    return sessionId && this.people?.tabOf(worktreeId, sessionId) ? { id: tabId, sessionId } : null
  }

  /** Adds a chat to the caller's person's own tabs; false when the caller is the owner's. */
  open(clientNavigationId: string, worktreeId: string, sessionId: string): boolean {
    const person = this.people?.personOf(clientNavigationId)
    if (person) {
      this.add(person, worktreeId, sessionId)
    }
    return person !== null && person !== undefined
  }

  /** Adds a chat to a person's own tabs by their person key. */
  add(person: string, worktreeId: string, sessionId: string): void {
    this.put(person, worktreeId, (tabs) => (tabs.includes(sessionId) ? tabs : [...tabs, sessionId]))
  }

  /** Drops a chat tab from the caller's person's own tabs; false when it was not one of them. */
  close(clientNavigationId: string, worktreeId: string, tabId: string): boolean {
    const person = this.people?.personOf(clientNavigationId)
    const tabs = this.sessionIdsOf(clientNavigationId, worktreeId)
    if (!person || !tabs?.some((id) => personSessionTabId(id) === tabId)) {
      return false
    }
    this.put(person, worktreeId, (current) =>
      current.filter((id) => personSessionTabId(id) !== tabId)
    )
    return true
  }

  /** Moves the person's tab set and bumps each of their devices' frames, so every one redraws. */
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
      shouldPersist: true,
      personTabs: next(state.personTabs ?? [])
    })
    for (const [clientNavigationId, statesByWorktree] of this.statesByClient) {
      const device = statesByWorktree.get(worktreeId)
      if (device && this.people?.personOf(clientNavigationId) === person) {
        statesByWorktree.set(worktreeId, { ...device, revision: device.revision + 1 })
      }
    }
    this.persist()
  }
}
