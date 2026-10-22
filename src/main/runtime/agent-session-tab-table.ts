import { agentSessionRefusalError } from '../../shared/agent-session-wire-refusals'
import { structuredAgentSessionTabId } from '../../shared/structured-agent-session-projection'
import type { AgentSessionStoreState } from './agent-session-store-state'

/**
 * Which conversation each structured chat tab shows, keyed by the host tab id.
 *
 * Membership is visibility: a session with an entry has a chat tab, and the key is that tab's id.
 * An id names one conversation, and a session maps back to at most one tab.
 */
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

  /** Sessions that have a tab, in the order their tabs were given out. */
  sessionIds(): string[] {
    return [...this.sessionByTab.values()]
  }

  entries(): [tabId: string, sessionId: string][] {
    return [...this.sessionByTab.entries()]
  }

  /**
   * Gives a session a tab unless it already has one. Without a reserved id it gets the id clients
   * derive for it.
   */
  show(sessionId: string, tabId?: string): void {
    if (this.tabBySession.has(sessionId)) {
      return
    }
    const derived = structuredAgentSessionTabId(sessionId)
    this.put(tabId ?? derived, sessionId)
  }

  /** Returns the id the session's tab had, if it had one. */
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

/** The sessions whose chat tab is shown, in tab order, skipping any without a record. */
export function listVisibleAgentSessionIds(state: AgentSessionStoreState): string[] {
  return (state.sessionTabs?.sessionIds() ?? []).filter((sessionId) => state.records.has(sessionId))
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
  tabId?: string
): void {
  if (visible && !state.records.has(sessionId)) {
    throw agentSessionRefusalError('agent_session_identity_required', { reason: 'recordMissing' })
  }
  state.sessionTabs ??= new AgentSessionTabTable()
  if (visible) {
    state.sessionTabs.show(sessionId, tabId)
  } else {
    state.sessionTabs.hide(sessionId)
  }
}

export function showAgentSessionTabs(
  state: AgentSessionStoreState,
  sessionIds: readonly string[]
): void {
  for (const sessionId of sessionIds) {
    if (state.records.has(sessionId)) {
      setAgentSessionTabVisibility(state, sessionId, true)
    }
  }
}

export type PersistedAgentSessionTab = { tabId: string; sessionId: string }
