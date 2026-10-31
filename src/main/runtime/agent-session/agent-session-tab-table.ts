import { AgentSessionRecordPublication } from '../agent-session-record-publication'
import { isAgentSessionSurfaceTabId } from '../../../shared/agent-session-surface-tab-id'
import type { AgentSessionReserveRequest } from './ownership/agent-session-reservation-admission'
import { agentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'
import { structuredAgentSessionTabId } from '../../../shared/structured-agent-session-projection'
import {
  hasAgentSessionConversation,
  type AgentSessionStoreState
} from '../agent-session-store-state'

/** Tab membership defines visibility; tab and session ids form a one-to-one mapping. */
export class AgentSessionTabTable {
  private readonly sessionByTab = new Map<string, string>()
  private readonly tabBySession = new Map<string, string>()

  constructor(entries: Iterable<readonly [tabId: string, sessionId: string]> = []) {
    for (const [tabId, sessionId] of entries) {
      this.put(tabId, sessionId)
    }
  }

  tabIdFor(sessionId: string): string | undefined {
    return this.tabBySession.get(sessionId)
  }

  sessionIdFor(tabId: string): string | undefined {
    return this.sessionByTab.get(tabId)
  }

  /** Visible sessions in tab issuance order. */
  sessionIds(): string[] {
    return [...this.sessionByTab.values()]
  }

  entries(): [tabId: string, sessionId: string][] {
    return [...this.sessionByTab.entries()]
  }

  /** Show once, using the reserved id or the id clients derive. */
  show(sessionId: string, tabId?: string): void {
    if (this.tabBySession.has(sessionId)) {
      return
    }
    const derived = structuredAgentSessionTabId(sessionId)
    this.put(tabId ?? derived, sessionId)
  }

  hide(sessionId: string): string | undefined {
    const tabId = this.tabBySession.get(sessionId)
    if (tabId !== undefined) {
      this.tabBySession.delete(sessionId)
      this.sessionByTab.delete(tabId)
    }
    return tabId
  }

  clone(): AgentSessionTabTable {
    return new AgentSessionTabTable(this.sessionByTab)
  }

  equals(other: AgentSessionTabTable): boolean {
    const left = this.entries()
    const right = other.entries()
    return (
      left.length === right.length &&
      left.every(([tabId, sessionId], index) => {
        const [otherTabId, otherSessionId] = right[index]
        return tabId === otherTabId && sessionId === otherSessionId
      })
    )
  }

  private put(tabId: string, sessionId: string): void {
    const owner = this.sessionByTab.get(tabId)
    if (owner !== undefined && owner !== sessionId) {
      throw agentSessionRefusalError('agent_session_conflict', { reason: 'tabIdTaken' })
    }
    this.hide(sessionId)
    this.sessionByTab.set(tabId, sessionId)
    this.tabBySession.set(sessionId, tabId)
  }
}

/** Derive the complete legacy selection only at a real ownership/visibility boundary. */
export function effectiveAgentSessionTabs(
  state: AgentSessionStoreState,
  legacyIds: readonly string[],
  ownShow?: string
): AgentSessionTabTable {
  if (state.sessionTabs) {
    return state.sessionTabs
  }
  const tabs = new AgentSessionTabTable()
  for (const id of legacyIds) {
    if (id !== ownShow && hasAgentSessionConversation(state, id)) {
      tabs.show(id)
    }
  }
  return tabs
}

/** An empty passive reconstruction cannot establish absence as authority. */
export function initializeAgentSessionTabs(
  state: AgentSessionStoreState,
  legacyIds: readonly string[]
): void {
  if (state.sessionTabs) {
    return
  }
  const tabs = effectiveAgentSessionTabs(state, legacyIds)
  if (tabs.entries().length > 0) {
    state.sessionTabs = tabs
  }
}

export function listVisibleAgentSessionIds(state: AgentSessionStoreState): string[] {
  return (state.sessionTabs?.sessionIds() ?? []).filter((sessionId) =>
    hasAgentSessionConversation(state, sessionId)
  )
}

export function agentSessionVisibleTabIndex(state: AgentSessionStoreState): {
  present: boolean
  sessionIds: string[]
} {
  return { present: state.sessionTabs !== null, sessionIds: listVisibleAgentSessionIds(state) }
}

export function setAgentSessionTabVisibility(
  state: AgentSessionStoreState,
  sessionId: string,
  visible: boolean,
  tabId?: string,
  legacyIds: readonly string[] = []
): void {
  if (visible && !hasAgentSessionConversation(state, sessionId)) {
    throw agentSessionRefusalError('agent_session_identity_required', { reason: 'recordMissing' })
  }
  state.sessionTabs ??= effectiveAgentSessionTabs(
    state,
    legacyIds,
    visible && tabId !== undefined ? sessionId : undefined
  )
  if (visible) {
    state.sessionTabs.show(sessionId, tabId)
  } else {
    state.sessionTabs.hide(sessionId)
  }
}

export function showAgentSessionTabs(
  state: AgentSessionStoreState,
  sessionIds: readonly string[],
  legacyIds: readonly string[] = []
): void {
  for (const sessionId of sessionIds) {
    if (hasAgentSessionConversation(state, sessionId)) {
      setAgentSessionTabVisibility(state, sessionId, true, undefined, legacyIds)
    }
  }
}

export type PersistedAgentSessionTab = { tabId: string; sessionId: string }

/** Check tab-id conflicts before spawn; claim only on publication so failed creates leave no restorable tab. */
export function assertReservedTabUnheld(
  state: AgentSessionStoreState,
  request: AgentSessionReserveRequest,
  legacyIds: readonly string[] = []
): void {
  if (request.surfaceTabId === undefined) {
    return
  }
  if (!isAgentSessionSurfaceTabId(request.surfaceTabId)) {
    throw agentSessionRefusalError('agent_session_operation_invalid', {
      reason: 'requestMalformed'
    })
  }
  const holder = effectiveAgentSessionTabs(state, legacyIds, request.sessionId).sessionIdFor(
    request.surfaceTabId
  )
  if (holder !== undefined && holder !== request.sessionId) {
    throw agentSessionRefusalError('agent_session_conflict', { reason: 'tabIdTaken' })
  }
}

/** Publish tab visibility through the same committed store boundary as record changes. */
export abstract class AgentSessionRecordTabs extends AgentSessionRecordPublication {
  private readonly legacyTabIds: ReadonlySet<string> = new Set(
    this.transactions.legacySessionTabIds
  )

  listVisibleSessionIds = (): string[] =>
    this.transactions.state.sessionTabs
      ? listVisibleAgentSessionIds(this.transactions.state)
      : this.transactions.legacySessionTabIds.filter((id) => this.isSessionTabVisible(id))

  isSessionTabVisible = (id: string): boolean =>
    (this.transactions.state.sessionTabs
      ? this.transactions.state.sessionTabs.tabIdFor(id) !== undefined
      : this.legacyTabIds.has(id)) && hasAgentSessionConversation(this.transactions.state, id)

  isSessionTabRetired = (id: string): boolean =>
    this.transactions.state.sessionTabs !== null && !this.isSessionTabVisible(id)

  initializeSessionTabs(): Promise<void> {
    return this.transact((draft) =>
      initializeAgentSessionTabs(draft, this.transactions.legacySessionTabIds)
    )
  }

  getVisibleSessionTabIndex = (): { present: boolean; sessionIds: string[] } =>
    agentSessionVisibleTabIndex(this.transactions.state)

  getSessionTabId = (sessionId: string): string | null =>
    this.transactions.state.sessionTabs?.tabIdFor(sessionId) ?? null

  /** Persist chat-tab identity separately from rollback-sensitive profile tabs; explicit tabId restores hidden tabs under their old ids. */
  setSessionTabVisibility(
    sessionId: string,
    visible: boolean,
    tabId?: string,
    check?: () => void
  ): Promise<void> {
    return this.transact((draft) => {
      check?.()
      return setAgentSessionTabVisibility(
        draft,
        sessionId,
        visible,
        tabId,
        this.transactions.legacySessionTabIds
      )
    })
  }

  setSwitchedSessionTabVisibility(
    sessionId: string,
    tabId: string,
    visible: boolean,
    admit: () => boolean
  ): Promise<boolean> {
    return this.transact((draft) => {
      if (
        (visible
          ? draft.sessionTabs?.tabIdFor(sessionId) !== undefined
          : draft.sessionTabs?.tabIdFor(sessionId) !== tabId) ||
        !admit()
      ) {
        return false
      }
      setAgentSessionTabVisibility(
        draft,
        sessionId,
        visible,
        tabId,
        this.transactions.legacySessionTabIds
      )
      return true
    })
  }

  /** Publish the complete tab index in one write; a partial index would drop remaining chats on restart. */
  showSessionTabs(sessionIds: readonly string[]): Promise<void> {
    return this.transact((draft) =>
      showAgentSessionTabs(draft, sessionIds, this.transactions.legacySessionTabIds)
    )
  }
}
