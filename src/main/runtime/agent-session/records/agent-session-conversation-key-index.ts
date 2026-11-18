import type { AgentSessionConversationView } from '../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import {
  getAgentSessionConversation,
  listAgentSessionConversations,
  type AgentSessionStoreState
} from './agent-session-store-state'

/** The lookup keys one chat answers to. Pass a module-level function: the store keeps one index
 *  per function, so a fresh closure would build a fresh index on every call. */
export type AgentSessionConversationKeys = (view: AgentSessionConversationView) => readonly string[]

/** One index per key function: built on first use, kept by committed writes, and rebuilt after a
 *  write that changes which rows are unreadable (listing order moves then). */
export class AgentSessionConversationKeyIndexes {
  private readonly indexes = new Map<
    AgentSessionConversationKeys,
    AgentSessionConversationKeyIndex
  >()

  get(
    state: AgentSessionStoreState,
    keys: AgentSessionConversationKeys
  ): AgentSessionConversationKeyIndex {
    let index = this.indexes.get(keys)
    if (!index) {
      index = new AgentSessionConversationKeyIndex(state, keys)
      this.indexes.set(keys, index)
    }
    return index
  }

  applyCommitted(
    state: AgentSessionStoreState,
    records: { upsert: readonly (readonly [string, string])[]; remove: readonly string[] },
    unreadableChanged: boolean
  ): void {
    if (unreadableChanged) {
      this.indexes.clear()
      return
    }
    this.indexes.forEach((index) => index.applyCommitted(state, records))
  }
}

/** Lookup keys of the loaded chats, mapped to the chats that answer to them: built once per store
 *  authority, then kept by committed record writes, so a keyed question never walks the history.
 *  Derived only; nothing is saved. */
export class AgentSessionConversationKeyIndex {
  private readonly sessionsByKey = new Map<string, Set<string>>()
  private readonly keysBySession = new Map<string, readonly string[]>()
  /** Each chat's place in listing order (readable records, then unreadable ones), mirrored from
   *  the store's maps so a shared key picks among its chats alone, as a full scan would. */
  private readonly readableOrder = new Map<string, number>()
  private readonly unreadableOrder = new Map<string, number>()
  private nextReadable = 0

  constructor(
    state: AgentSessionStoreState,
    private readonly keysOf: AgentSessionConversationKeys
  ) {
    for (const sessionId of state.records.keys()) {
      this.readableOrder.set(sessionId, this.nextReadable++)
    }
    for (const sessionId of state.unreadableRecords.keys()) {
      this.unreadableOrder.set(sessionId, this.unreadableOrder.size)
    }
    for (const view of listAgentSessionConversations(state)) {
      this.add(view)
    }
  }

  /** Follows one committed transaction: only the written records' places and keys move. */
  applyCommitted(
    draft: AgentSessionStoreState,
    records: { upsert: readonly (readonly [string, string])[]; remove: readonly string[] }
  ): void {
    // SQL acknowledgements append new records and retain existing records' listing order.
    const appended = records.upsert.map(([id]) => id).filter((id) => !this.readableOrder.has(id))
    for (const sessionId of appended) {
      if (draft.records.has(sessionId)) {
        this.readableOrder.set(sessionId, this.nextReadable++)
      }
    }
    for (const sessionId of records.remove) {
      this.readableOrder.delete(sessionId)
    }
    for (const sessionId of [...records.upsert.map(([id]) => id), ...records.remove]) {
      this.remove(sessionId)
      const view = getAgentSessionConversation(draft, sessionId)
      if (view) {
        this.add(view)
      }
    }
  }

  /** The chats answering to `key`, in listing order. */
  sessionIds(key: string): string[] {
    return [...(this.sessionsByKey.get(key) ?? [])].sort((a, b) =>
      this.precedes(a, b) ? -1 : this.precedes(b, a) ? 1 : 0
    )
  }

  /** The first chat in listing order answering to `key`. */
  first(key: string): string | null {
    let first: string | null = null
    for (const sessionId of this.sessionsByKey.get(key) ?? []) {
      if (first === null || this.precedes(sessionId, first)) {
        first = sessionId
      }
    }
    return first
  }

  private precedes(a: string, b: string): boolean {
    const readableA = this.readableOrder.get(a)
    const readableB = this.readableOrder.get(b)
    if (readableA !== undefined || readableB !== undefined) {
      return readableB === undefined || (readableA !== undefined && readableA < readableB)
    }
    return (this.unreadableOrder.get(a) ?? Infinity) < (this.unreadableOrder.get(b) ?? Infinity)
  }

  private add(view: AgentSessionConversationView): void {
    const keys = this.keysOf(view)
    this.keysBySession.set(view.sessionId, keys)
    for (const key of keys) {
      const sessions = this.sessionsByKey.get(key) ?? new Set<string>()
      sessions.add(view.sessionId)
      this.sessionsByKey.set(key, sessions)
    }
  }

  private remove(sessionId: string): void {
    for (const key of this.keysBySession.get(sessionId) ?? []) {
      const sessions = this.sessionsByKey.get(key)
      sessions?.delete(sessionId)
      if (sessions?.size === 0) {
        this.sessionsByKey.delete(key)
      }
    }
    this.keysBySession.delete(sessionId)
  }
}
