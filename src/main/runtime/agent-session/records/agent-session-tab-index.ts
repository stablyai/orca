import { agentSessionRefusalError } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import { structuredAgentSessionTabId } from '../../../../shared/agent-session/view/structured-agent-session-projection'

/** Tab membership defines visibility; tab and session ids form a one-to-one mapping. */
export class AgentSessionTabTable {
  private readonly sessionByTab = new Map<string, string>()
  private readonly tabBySession = new Map<string, string>()
  /** Live chats with no tab (started in the background, or kept running past their tab's close);
   *  unlike a chat whose tab a person closed, they are still open. */
  private readonly background = new Set<string>()
  /** Bot chats a person ended: no tab, not in the background, and no turn starts until shown again. */
  private readonly ended = new Set<string>()
  /** TEMPORARY, with `backfillBackgroundSessions`: set once chats from before the list are added. */
  backgroundBackfilled = false

  constructor(
    entries: Iterable<readonly [tabId: string, sessionId: string]> = [],
    background: Iterable<string> = [],
    ended: Iterable<string> = []
  ) {
    for (const [tabId, sessionId] of entries) {
      this.put(tabId, sessionId)
    }
    for (const sessionId of background) {
      this.holdInBackground(sessionId)
    }
    for (const sessionId of ended) {
      if (this.tabBySession.has(sessionId) || this.background.has(sessionId)) {
        continue
      }
      this.ended.add(sessionId)
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
    this.ended.delete(sessionId)
    this.background.add(sessionId)
  }

  /** Take the tab and the background hold away, and refuse new turns until it is shown again. */
  end(sessionId: string): void {
    this.hide(sessionId)
    this.ended.add(sessionId)
  }

  isInBackground(sessionId: string): boolean {
    return this.background.has(sessionId)
  }

  isEnded(sessionId: string): boolean {
    return this.ended.has(sessionId)
  }

  backgroundSessionIds(): string[] {
    return [...this.background]
  }

  endedSessionIds(): string[] {
    return [...this.ended]
  }

  clone(): AgentSessionTabTable {
    const copy = new AgentSessionTabTable(this.sessionByTab, this.background, this.ended)
    copy.backgroundBackfilled = this.backgroundBackfilled
    return copy
  }

  equals(other: AgentSessionTabTable): boolean {
    const left = this.entries()
    const right = other.entries()
    return (
      this.backgroundBackfilled === other.backgroundBackfilled &&
      sameMembers(this.background, other.background) &&
      sameMembers(this.ended, other.ended) &&
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
    this.ended.delete(sessionId)
    this.sessionByTab.set(tabId, sessionId)
    this.tabBySession.set(sessionId, tabId)
  }
}

function sameMembers(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((id) => right.has(id))
}

/** The background and ended lists as they cross the writer boundary beside the tab entries. */
export type StoredAgentSessionBackground = { ids: string[]; backfilled: boolean; ended?: string[] }

export function storedAgentSessionBackground(
  table: AgentSessionTabTable | null
): StoredAgentSessionBackground | null {
  return table
    ? {
        ids: table.backgroundSessionIds(),
        backfilled: table.backgroundBackfilled,
        ended: table.endedSessionIds()
      }
    : null
}

export function agentSessionTabTableFromStored(
  entries: Iterable<readonly [tabId: string, sessionId: string]>,
  background: StoredAgentSessionBackground | null | undefined
): AgentSessionTabTable {
  const table = new AgentSessionTabTable(entries, background?.ids ?? [], background?.ended ?? [])
  table.backgroundBackfilled = background?.backfilled ?? false
  return table
}
