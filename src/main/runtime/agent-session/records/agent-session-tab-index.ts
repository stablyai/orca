import { agentSessionRefusalError } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import { structuredAgentSessionTabId } from '../../../../shared/agent-session/view/structured-agent-session-projection'

/** Tab membership defines visibility; tab and session ids form a one-to-one mapping. */
export class AgentSessionTabTable {
  private readonly sessionByTab = new Map<string, string>()
  private readonly tabBySession = new Map<string, string>()
  /** Live chats with no tab (started in the background, or kept running past their tab's close);
   *  unlike a chat whose tab a person closed, they are still open. */
  private readonly background = new Set<string>()
  /** Bot chats a person ended: no tab, not in the background, and no turn starts until shown again.
   *  Shared with the table this one was cloned from (or into) until either changes it, so a write
   *  that ends or reopens nothing copies and compares none of them. */
  private ended = new Set<string>()
  private endedShared = false
  /** The ended set this table was cloned from, and how its own differs: true added, false removed. */
  private endedSource: ReadonlySet<string> | null = null
  private readonly endedChanges = new Map<string, boolean>()
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

  private setEnded(sessionId: string, ended: boolean): void {
    if (this.ended.has(sessionId) === ended) {
      return
    }
    if (this.endedShared) {
      this.ended = new Set(this.ended)
      this.endedShared = false
    }
    if (ended) {
      this.ended.add(sessionId)
    } else {
      this.ended.delete(sessionId)
    }
    // Each change flips membership, so a second one returns it to the source's.
    if (!this.endedChanges.delete(sessionId)) {
      this.endedChanges.set(sessionId, ended)
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

  /** Take the tab away but keep the chat open. An ended chat stays ended: only a show reopens it,
   *  so a late close of its earlier tab or background hold cannot restore its reach. */
  holdInBackground(sessionId: string): void {
    this.hide(sessionId)
    if (!this.ended.has(sessionId)) {
      this.background.add(sessionId)
    }
  }

  /** Take the tab and the background hold away, and refuse new turns until it is shown again. */
  end(sessionId: string): void {
    this.hide(sessionId)
    this.setEnded(sessionId, true)
  }

  /** The chat's record is gone: drop every trace of it here too, the ended mark included. */
  forget(sessionId: string): void {
    this.hide(sessionId)
    this.setEnded(sessionId, false)
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

  /** The ended chats this table added and removed against `from`; null when it changed none. Only
   *  those changes when this table was cloned from `from`, else the two sets compared whole. */
  endedChangesSince(from: AgentSessionTabTable | null): { add: string[]; remove: string[] } | null {
    if (from && this.endedSource === from.ended) {
      if (this.endedChanges.size === 0) {
        return null
      }
      const changes = [...this.endedChanges]
      return {
        add: changes.filter(([, ended]) => ended).map(([id]) => id),
        remove: changes.filter(([, ended]) => !ended).map(([id]) => id)
      }
    }
    const before: ReadonlySet<string> = from?.ended ?? new Set()
    const add = [...this.ended].filter((id) => !before.has(id))
    const remove = [...before].filter((id) => !this.ended.has(id))
    return add.length + remove.length > 0 ? { add, remove } : null
  }

  /** Rebuilt from a write's rows: the ended chats of the table it replaces, with the write's changes. */
  carryEnded(
    from: AgentSessionTabTable | null,
    changes: { add: readonly string[]; remove: readonly string[] } | null
  ): void {
    if (from) {
      this.ended = from.ended
      this.endedShared = true
      from.endedShared = true
    }
    for (const id of changes?.add ?? []) {
      this.setEnded(id, true)
    }
    for (const id of changes?.remove ?? []) {
      this.setEnded(id, false)
    }
    this.endedSource = null
    this.endedChanges.clear()
  }

  clone(): AgentSessionTabTable {
    const copy = new AgentSessionTabTable(this.sessionByTab, this.background)
    copy.ended = this.ended
    copy.endedSource = this.ended
    copy.endedShared = true
    this.endedShared = true
    copy.backgroundBackfilled = this.backgroundBackfilled
    return copy
  }

  equals(other: AgentSessionTabTable): boolean {
    const left = this.entries()
    const right = other.entries()
    return (
      this.backgroundBackfilled === other.backgroundBackfilled &&
      sameMembers(this.background, other.background) &&
      (this.ended === other.ended || sameMembers(this.ended, other.ended)) &&
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
    this.setEnded(sessionId, false)
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
