import { AgentSessionRecordPublication } from './agent-session-record-publication'
import { isAgentSessionSurfaceTabId } from '../../../../shared/agent-session/view/agent-session-surface-tab-id'
import type { AgentSessionReserveRequest } from '../ownership/agent-session-reservation-admission'
import { agentSessionRefusalError } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import { structuredAgentSessionTabId } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import {
  hasAgentSessionConversation,
  listAgentSessionConversations,
  type AgentSessionStoreState
} from './agent-session-store-state'
import type { AgentSessionConversationView } from '../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'

/** Tab membership defines visibility; tab and session ids form a one-to-one mapping. */
export class AgentSessionTabTable {
  private readonly sessionByTab = new Map<string, string>()
  private readonly tabBySession = new Map<string, string>()
  /** Live chats with no tab (started in the background, or kept running past their tab's close);
   *  unlike a chat whose tab a person closed, they are still open. */
  private readonly background = new Set<string>()
  /** TEMPORARY, with `backfillBackgroundSessions`: set once chats from before the list are added. */
  backgroundBackfilled = false

  constructor(
    entries: Iterable<readonly [tabId: string, sessionId: string]> = [],
    background: Iterable<string> = []
  ) {
    for (const [tabId, sessionId] of entries) {
      this.put(tabId, sessionId)
    }
    for (const sessionId of background) {
      this.holdInBackground(sessionId)
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
    this.background.delete(sessionId)
    const tabId = this.tabBySession.get(sessionId)
    if (tabId !== undefined) {
      this.tabBySession.delete(sessionId)
      this.sessionByTab.delete(tabId)
    }
    return tabId
  }

  /** Take the tab away but keep the chat open. */
  holdInBackground(sessionId: string): void {
    this.hide(sessionId)
    this.background.add(sessionId)
  }

  isInBackground(sessionId: string): boolean {
    return this.background.has(sessionId)
  }

  backgroundSessionIds(): string[] {
    return [...this.background]
  }

  clone(): AgentSessionTabTable {
    const copy = new AgentSessionTabTable(this.sessionByTab, this.background)
    copy.backgroundBackfilled = this.backgroundBackfilled
    return copy
  }

  equals(other: AgentSessionTabTable): boolean {
    const left = this.entries()
    const right = other.entries()
    return (
      this.backgroundBackfilled === other.backgroundBackfilled &&
      this.background.size === other.background.size &&
      [...this.background].every((sessionId) => other.background.has(sessionId)) &&
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

/** The background list as it crosses the writer boundary beside the tab entries. */
export type StoredAgentSessionBackground = { ids: string[]; backfilled: boolean }

export function storedAgentSessionBackground(
  table: AgentSessionTabTable | null
): StoredAgentSessionBackground | null {
  return table
    ? { ids: table.backgroundSessionIds(), backfilled: table.backgroundBackfilled }
    : null
}

export function agentSessionTabTableFromStored(
  entries: Iterable<readonly [tabId: string, sessionId: string]>,
  background: StoredAgentSessionBackground | null | undefined
): AgentSessionTabTable {
  const table = new AgentSessionTabTable(entries, background?.ids ?? [])
  table.backgroundBackfilled = background?.backfilled ?? false
  return table
}

/** TEMPORARY, with `backfillBackgroundSessions`: holds the named tabless chats once. */
export function backfillAgentSessionBackground(
  state: AgentSessionStoreState,
  sessionIds: readonly string[]
): string[] {
  const tabs = state.sessionTabs
  if (!tabs || tabs.backgroundBackfilled) {
    return []
  }
  const added = sessionIds.filter(
    (id) => tabs.tabIdFor(id) === undefined && hasAgentSessionConversation(state, id)
  )
  for (const sessionId of added) {
    tabs.holdInBackground(sessionId)
  }
  tabs.backgroundBackfilled = true
  return added
}

export type AgentSessionTabVisibilityOptions = {
  writerFence?: Int32Array
  check?: () => void
  capture?: (tabId: string | null) => void
  /** Hide the tab but keep the chat open (see `isSessionInBackground`). */
  background?: boolean
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
  legacyIds: readonly string[] = [],
  background = false
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
  } else if (background) {
    state.sessionTabs.holdInBackground(sessionId)
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
    return this.commitStoreCommand({
      kind: 'tabs-initialize',
      legacyTabIds: this.transactions.legacySessionTabIds
    })
  }

  getVisibleSessionTabIndex = (): { present: boolean; sessionIds: string[] } =>
    agentSessionVisibleTabIndex(this.transactions.state)

  getSessionTabId = (sessionId: string): string | null =>
    this.transactions.state.sessionTabs?.tabIdFor(sessionId) ?? null

  /** A live chat with no tab, which no person closed. */
  isSessionInBackground = (id: string): boolean =>
    (this.transactions.state.sessionTabs?.isInBackground(id) ?? false) &&
    hasAgentSessionConversation(this.transactions.state, id)

  /** TEMPORARY (delete after the next release): adds once the tabless chats `select` names that
   *  predate the background list. Returns the ids added. */
  backfillBackgroundSessions(
    select: (conversation: AgentSessionConversationView) => boolean
  ): Promise<string[]> {
    const { state } = this.transactions
    if (!state.sessionTabs || state.sessionTabs.backgroundBackfilled) {
      return Promise.resolve([])
    }
    // The predicate runs here; the writer re-checks each chat is still tabless.
    const sessionIds = listAgentSessionConversations(state)
      .filter((conversation) => state.sessionTabs?.tabIdFor(conversation.sessionId) === undefined)
      .filter(select)
      .map(({ sessionId }) => sessionId)
    return this.commitStoreCommand({ kind: 'tabs-background-backfill', sessionIds })
  }

  /** Persist chat-tab identity separately from rollback-sensitive profile tabs; explicit tabId restores hidden tabs under their old ids. */
  setSessionTabVisibility(
    sessionId: string,
    visible: boolean,
    tabId?: string,
    { check, capture, background, writerFence }: AgentSessionTabVisibilityOptions = {}
  ): Promise<void> {
    return this.commitStoreCommand(
      {
        kind: 'tab-visibility',
        sessionId,
        visible,
        tabId,
        legacyTabIds: this.transactions.legacySessionTabIds,
        ...(writerFence ? { writerFence } : {}),
        ...(background ? { background: true } : {})
      },
      check
    ).then((tab) => {
      capture?.(tab)
    })
  }

  /** Publish the complete tab index in one write; a partial index would drop remaining chats on restart. */
  showSessionTabs(sessionIds: readonly string[]): Promise<void> {
    return this.commitStoreCommand({
      kind: 'tabs-show',
      sessionIds,
      legacyTabIds: this.transactions.legacySessionTabIds
    })
  }
}
