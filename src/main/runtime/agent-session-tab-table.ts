import { isAgentSessionId, type AgentSessionRecord } from '../../shared/agent-session-record'
import { isAgentSessionSurfaceTabId } from '../../shared/agent-session-surface-tab-id'
import { structuredAgentSessionTabId } from '../../shared/structured-agent-session-projection'
import type { AgentSessionStoreState } from './agent-session-record-store-file'

/**
 * Which conversation each structured chat tab shows, keyed by the host tab id.
 *
 * Membership is visibility: a session with an entry has a chat tab, and the key is that tab's id.
 * A /clear moves the tab to the replacement conversation rather than copying its id, so an id names
 * one conversation by construction and a session maps back to at most one tab.
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
   * derive for it, unless a cleared conversation's tab kept that id.
   */
  show(sessionId: string, tabId?: string): void {
    if (this.tabBySession.has(sessionId)) {
      return
    }
    const derived = structuredAgentSessionTabId(sessionId)
    const held = (candidate: string): boolean => this.sessionByTab.has(candidate)
    this.put(tabId ?? (held(derived) ? reopenedTabId(sessionId, held) : derived), sessionId)
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

  /** A /clear: the tab that showed `fromSessionId` shows `toSessionId`, keeping its id and place. */
  move(fromSessionId: string, toSessionId: string): void {
    const tabId = this.tabBySession.get(fromSessionId)
    this.hide(toSessionId)
    if (tabId === undefined) {
      this.show(toSessionId)
      return
    }
    this.tabBySession.delete(fromSessionId)
    this.sessionByTab.set(tabId, toSessionId)
    this.tabBySession.set(toSessionId, tabId)
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
      throw new Error('agent_session_conflict')
    }
    this.hide(sessionId)
    this.sessionByTab.set(tabId, sessionId)
    this.tabBySession.set(sessionId, tabId)
  }
}

/**
 * The id a cleared conversation reopened from history takes while the tab now showing its
 * replacement holds its own. Deterministic, so a table seeded again gives it the same id.
 */
function reopenedTabId(sessionId: string, held: (tabId: string) => boolean): string {
  const base = `${structuredAgentSessionTabId(sessionId)}-reopened`
  let tabId = base
  for (let suffix = 2; held(tabId); suffix++) {
    tabId = `${base}-${suffix}`
  }
  return tabId
}

export function setAgentSessionTabVisibility(
  state: AgentSessionStoreState,
  sessionId: string,
  visible: boolean,
  tabId?: string
): void {
  if (visible && !state.records.has(sessionId)) {
    throw new Error('agent_session_identity_required')
  }
  state.sessionTabs ??= new AgentSessionTabTable()
  if (visible) {
    state.sessionTabs.show(sessionId, tabId)
  } else {
    state.sessionTabs.hide(sessionId)
  }
}

export type PersistedAgentSessionTab = { tabId: string; sessionId: string }

export function serializeAgentSessionTabTable(table: AgentSessionTabTable): {
  sessionTabs: PersistedAgentSessionTab[]
  visibleSessionIds: string[]
} {
  return {
    sessionTabs: table.entries().map(([tabId, sessionId]) => ({ tabId, sessionId })),
    // Written for older builds, which restore tabs from this list; never read beside the table.
    visibleSessionIds: table.sessionIds()
  }
}

/**
 * Reads the persisted table, or seeds it from what older builds wrote: the visible session list and,
 * for a chat created by a build that recorded one, the tab id on its record. That record field is
 * read here and nowhere else, and only when the file carries no table.
 *
 * Deterministic on purpose: a parsed store must hash the same on every read of the same bytes.
 */
export function parseAgentSessionTabTable(
  file: { sessionTabs?: unknown; visibleSessionIds?: unknown },
  records: ReadonlyMap<string, AgentSessionRecord>,
  strict: boolean
): { valid: boolean; table: AgentSessionTabTable | null } {
  if (file.sessionTabs !== undefined) {
    return parsePersistedTabs(file.sessionTabs, strict)
  }
  if (file.visibleSessionIds === undefined) {
    return { valid: true, table: null }
  }
  if (!Array.isArray(file.visibleSessionIds)) {
    return { valid: !strict, table: null }
  }
  return { valid: true, table: seedFromVisibleSessions(file.visibleSessionIds, records) }
}

/**
 * A cleared chat's tab was opened for the first conversation of its /clear chain and kept that id
 * through every clear, so the chat now showing the chain's latest conversation seeds under the
 * first one's id, as a /clear on this build would have left it. Those chats seed first: a cleared
 * conversation reopened from history is the later tab, and takes a fresh id if its own is held.
 */
function seedFromVisibleSessions(
  visible: readonly unknown[],
  records: ReadonlyMap<string, AgentSessionRecord>
): AgentSessionTabTable {
  const sessionIds = [...new Set(visible.filter(isAgentSessionId))]
  const clearedFrom = new Map<string, string>()
  for (const record of records.values()) {
    const command = record.conversationCommand
    if (
      command?.command === 'clear' &&
      command.phase === 'committed' &&
      command.replacementSessionId &&
      !clearedFrom.has(command.replacementSessionId)
    ) {
      clearedFrom.set(command.replacementSessionId, record.sessionId)
    }
  }
  const clearedTo = new Set(clearedFrom.values())
  const chainRoot = (sessionId: string): string => {
    const seen = new Set([sessionId])
    let current = sessionId
    let prior = clearedFrom.get(current)
    while (prior !== undefined && !seen.has(prior)) {
      seen.add(prior)
      current = prior
      prior = clearedFrom.get(current)
    }
    return current
  }
  const recordedOrDerived = (sessionId: string): string[] => {
    const record = records.get(sessionId)
    const recorded = record && 'surfaceTabId' in record ? record.surfaceTabId : undefined
    return [recorded, structuredAgentSessionTabId(sessionId)].filter(isAgentSessionSurfaceTabId)
  }
  const tabIds = new Map<string, string>()
  const taken = new Set<string>()
  const held = (tabId: string): boolean => taken.has(tabId)
  const assign = (sessionId: string, candidates: readonly string[]): void => {
    const tabId = candidates.find((candidate) => !held(candidate)) ?? reopenedTabId(sessionId, held)
    taken.add(tabId)
    tabIds.set(sessionId, tabId)
  }
  const holdsChainTab = (sessionId: string): boolean =>
    !clearedTo.has(sessionId) && chainRoot(sessionId) !== sessionId
  for (const sessionId of sessionIds.filter(holdsChainTab)) {
    assign(sessionId, [...recordedOrDerived(chainRoot(sessionId)), ...recordedOrDerived(sessionId)])
  }
  for (const sessionId of sessionIds.filter((sessionId) => !holdsChainTab(sessionId))) {
    assign(sessionId, recordedOrDerived(sessionId))
  }
  // In the visible list's order, which is the order older builds restored tabs in.
  return new AgentSessionTabTable(
    sessionIds.flatMap((sessionId) => {
      const tabId = tabIds.get(sessionId)
      return tabId === undefined ? [] : [[tabId, sessionId] as const]
    })
  )
}

function parsePersistedTabs(
  raw: unknown,
  strict: boolean
): { valid: boolean; table: AgentSessionTabTable | null } {
  if (!Array.isArray(raw)) {
    return { valid: !strict, table: null }
  }
  const table = new AgentSessionTabTable()
  for (const entry of raw) {
    const tabId: unknown = entry?.tabId
    const sessionId: unknown = entry?.sessionId
    const wellFormed =
      isAgentSessionSurfaceTabId(tabId) &&
      isAgentSessionId(sessionId) &&
      table.sessionIdFor(tabId) === undefined &&
      table.tabIdFor(sessionId) === undefined
    if (wellFormed) {
      table.show(sessionId, tabId)
    } else if (strict) {
      return { valid: false, table: null }
    }
  }
  return { valid: true, table }
}
