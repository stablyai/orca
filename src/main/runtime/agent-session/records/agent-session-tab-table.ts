import { randomUUID } from 'node:crypto'
import { AgentSessionRecordPublication } from './agent-session-record-publication'
import { isAgentSessionSurfaceTabId } from '../../../../shared/agent-session/view/agent-session-surface-tab-id'
import type { AgentSessionReserveRequest } from '../ownership/agent-session-reservation-admission'
import { agentSessionRefusalError } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import { AgentSessionTabTable } from './agent-session-tab-index'
import {
  hasAgentSessionConversation,
  listAgentSessionConversations,
  type AgentSessionStoreState
} from './agent-session-store-state'
import type { AgentSessionConversationView } from '../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'

export {
  AgentSessionTabTable,
  agentSessionTabTableFromStored,
  storedAgentSessionBackground,
  type StoredAgentSessionBackground
} from './agent-session-tab-index'

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
  /** Hide the tab, drop any background hold, and mark the bot chat ended (see `isSessionEnded`). */
  end?: boolean
  /** A publish that opens nothing new (no activation): a tab already listed keeps its showing. */
  keepShowing?: boolean
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
  background = false,
  end = false
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
  } else if (end) {
    state.sessionTabs.end(sessionId)
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

  /** In memory only: each listed tab's current showing, renewed by every explicit show. */
  private readonly showings = new Map<string, string>()

  /** Names the current showing of a session's tab, so a late close of an earlier one is told apart. */
  getSessionTabShowing = (id: string): string | null => {
    if (!this.isSessionTabVisible(id)) {
      this.showings.delete(id)
      return null
    }
    const showing = this.showings.get(id) ?? randomUUID()
    this.showings.set(id, showing)
    return showing
  }

  /** A bot chat a person ended, until it is shown again. */
  isSessionEnded = (id: string): boolean =>
    (this.transactions.state.sessionTabs?.isEnded(id) ?? false) &&
    hasAgentSessionConversation(this.transactions.state, id)

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
    {
      check,
      capture,
      background,
      end,
      writerFence,
      keepShowing
    }: AgentSessionTabVisibilityOptions = {}
  ): Promise<void> {
    // Decided in the write's own turn of the store queue, against the writes before it: two shows
    // queued back to back on a hidden tab keep the one name the first gave it.
    let sameShowing = false
    const decide = keepShowing
      ? () => {
          check?.()
          sameShowing = visible && this.isSessionTabVisible(sessionId)
        }
      : check
    return this.commitStoreCommand(
      {
        kind: 'tab-visibility',
        sessionId,
        visible,
        tabId,
        legacyTabIds: this.transactions.legacySessionTabIds,
        ...(writerFence ? { writerFence } : {}),
        ...(background ? { background: true } : {}),
        ...(end ? { end: true } : {})
      },
      decide
    ).then((tab) => {
      // Before any later write's check runs: a show is a new showing even of a listed tab, unless
      // it opens nothing new; a hide in between dropped the old name, so the next read mints one.
      if (visible) {
        if (!sameShowing) {
          this.showings.set(sessionId, randomUUID())
        }
      } else {
        this.showings.delete(sessionId)
      }
      capture?.(tab)
    })
  }

  /** Publish the complete tab index in one write; a partial index would drop remaining chats on restart. */
  showSessionTabs(sessionIds: readonly string[]): Promise<void> {
    const hidden = sessionIds.filter((id) => !this.isSessionTabVisible(id))
    return this.commitStoreCommand({
      kind: 'tabs-show',
      sessionIds,
      legacyTabIds: this.transactions.legacySessionTabIds
    }).then(() => {
      hidden.forEach((id) => this.showings.delete(id))
    })
  }
}
