import type { AgentSessionConversationView } from '../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import {
  agentSessionExecutionLocationsEqual,
  agentSessionScopeKey,
  type AgentSessionExecutionLocation
} from '../../../../shared/agent-session/lifecycle/agent-session-record'
import {
  getAgentSessionConversation,
  listAgentSessionConversations,
  type AgentSessionStoreState
} from './agent-session-store-state'

/** What keys may depend on: a write that leaves these alone (a lease renewal) moves no key. */
type AgentSessionConversationKeyInputs = Pick<
  AgentSessionConversationView,
  'provider' | 'location' | 'providerHandleChain'
>

/** The lookup keys one chat answers to. Pass a module-level function: the store keeps one index
 *  per function, so a fresh closure would build a fresh index on every call. */
export type AgentSessionConversationKeys = (
  inputs: AgentSessionConversationKeyInputs
) => readonly string[]

const nativeIdKeys: AgentSessionConversationKeys = (view) =>
  view.providerHandleChain.map(({ handle }) => handle.nativeId)

const scopeKeys: AgentSessionConversationKeys = (view) => [agentSessionScopeKey(view.location)]

type MovedChat = {
  before: AgentSessionConversationView | null
  after: AgentSessionConversationView | null
}

type CommittedRecords = {
  upsert: readonly (readonly [string, string])[]
  remove: readonly string[]
}

/** One index per key function, sharing one listing order: built on first use, kept by committed
 *  writes, and rebuilt after a write that changes which rows are unreadable (order moves then). */
export class AgentSessionConversationKeyIndexes {
  private readonly indexes = new Map<
    AgentSessionConversationKeys,
    AgentSessionConversationKeyIndex
  >()
  private order: AgentSessionListingOrder | null = null

  get(
    state: AgentSessionStoreState,
    keys: AgentSessionConversationKeys
  ): AgentSessionConversationKeyIndex {
    let index = this.indexes.get(keys)
    if (!index) {
      this.order ??= new AgentSessionListingOrder(state)
      index = new AgentSessionConversationKeyIndex(state, keys, this.order)
      this.indexes.set(keys, index)
    }
    return index
  }

  /** The chats answering to `key` under `keys`, in listing order, without walking the history. */
  conversations(
    state: AgentSessionStoreState,
    keys: AgentSessionConversationKeys,
    key: string
  ): AgentSessionConversationView[] {
    return this.get(state, keys)
      .sessionIds(key)
      .flatMap((sessionId) => getAgentSessionConversation(state, sessionId) ?? [])
  }

  /** The chats of exactly this workspace's scope (host, distro, workspace id), in listing order. */
  inScope(state: AgentSessionStoreState, location: AgentSessionExecutionLocation) {
    return this.conversations(state, scopeKeys, agentSessionScopeKey(location))
  }

  /** The chat whose handle chain names `nativeId`; with several, the first in listing order. */
  providerAliasOwner(state: AgentSessionStoreState, nativeId: string): string | null {
    return this.get(state, nativeIdKeys).first(nativeId)
  }

  applyCommitted(
    before: AgentSessionStoreState,
    state: AgentSessionStoreState,
    records: CommittedRecords,
    unreadableChanged: boolean
  ): void {
    if (unreadableChanged) {
      this.indexes.clear()
      this.order = null
      return
    }
    this.order?.applyCommitted(state, records)
    if (this.indexes.size === 0) {
      return
    }
    const moved = [...records.upsert.map(([sessionId]) => sessionId), ...records.remove]
      .map((sessionId) => ({
        before: getAgentSessionConversation(before, sessionId),
        after: getAgentSessionConversation(state, sessionId)
      }))
      .filter(({ before, after }) => !sameKeyInputs(before, after))
    this.indexes.forEach((index) => index.applyCommitted(moved))
  }
}

/** Each chat's place in listing order (readable records, then unreadable ones), mirrored from the
 *  store's maps so a shared key picks among its chats alone, as a full scan would. */
class AgentSessionListingOrder {
  private readonly readable = new Map<string, number>()
  private readonly unreadable = new Map<string, number>()
  private nextReadable = 0

  constructor(state: AgentSessionStoreState) {
    for (const sessionId of state.records.keys()) {
      this.readable.set(sessionId, this.nextReadable++)
    }
    for (const sessionId of state.unreadableRecords.keys()) {
      this.unreadable.set(sessionId, this.unreadable.size)
    }
  }

  applyCommitted(draft: AgentSessionStoreState, records: CommittedRecords): void {
    // SQL acknowledgements append new records and retain existing records' listing order.
    for (const [sessionId] of records.upsert) {
      if (!this.readable.has(sessionId) && draft.records.has(sessionId)) {
        this.readable.set(sessionId, this.nextReadable++)
      }
    }
    for (const sessionId of records.remove) {
      this.readable.delete(sessionId)
    }
  }

  precedes(a: string, b: string): boolean {
    const readableA = this.readable.get(a)
    const readableB = this.readable.get(b)
    if (readableA !== undefined || readableB !== undefined) {
      return readableB === undefined || (readableA !== undefined && readableA < readableB)
    }
    return (this.unreadable.get(a) ?? Infinity) < (this.unreadable.get(b) ?? Infinity)
  }
}

/** Lookup keys of the loaded chats, mapped to the chats that answer to them: built once per store
 *  authority, then kept by committed record writes, so a keyed question never walks the history.
 *  Derived only; nothing is saved. */
export class AgentSessionConversationKeyIndex {
  /** Keys are not stored per chat: a commit re-derives the old ones from the chat's prior view. */
  private readonly sessionsByKey = new Map<string, Set<string>>()

  constructor(
    state: AgentSessionStoreState,
    private readonly keysOf: AgentSessionConversationKeys,
    private readonly order: AgentSessionListingOrder
  ) {
    for (const view of listAgentSessionConversations(state)) {
      this.add(view)
    }
  }

  /** Follows one committed transaction: only the chats whose key inputs moved are re-keyed. */
  applyCommitted(moved: readonly MovedChat[]): void {
    for (const { before, after } of moved) {
      if (before) {
        this.remove(before)
      }
      if (after) {
        this.add(after)
      }
    }
  }

  /** The chats answering to `key`, in listing order. */
  sessionIds(key: string): string[] {
    return [...(this.sessionsByKey.get(key) ?? [])].sort((a, b) =>
      this.order.precedes(a, b) ? -1 : this.order.precedes(b, a) ? 1 : 0
    )
  }

  /** The first chat in listing order answering to `key`. */
  first(key: string): string | null {
    let first: string | null = null
    for (const sessionId of this.sessionsByKey.get(key) ?? []) {
      if (first === null || this.order.precedes(sessionId, first)) {
        first = sessionId
      }
    }
    return first
  }

  private add(view: AgentSessionConversationView): void {
    for (const key of this.keysOf(view)) {
      const sessions = this.sessionsByKey.get(key) ?? new Set<string>()
      sessions.add(view.sessionId)
      this.sessionsByKey.set(key, sessions)
    }
  }

  private remove(view: AgentSessionConversationView): void {
    for (const key of this.keysOf(view)) {
      const sessions = this.sessionsByKey.get(key)
      sessions?.delete(view.sessionId)
      if (sessions?.size === 0) {
        this.sessionsByKey.delete(key)
      }
    }
  }
}

function sameKeyInputs(
  before: AgentSessionConversationKeyInputs | null,
  after: AgentSessionConversationKeyInputs | null
): boolean {
  return (
    !!before &&
    !!after &&
    before.provider === after.provider &&
    agentSessionExecutionLocationsEqual(before.location, after.location) &&
    before.providerHandleChain.length === after.providerHandleChain.length &&
    before.providerHandleChain.every((link, index) => {
      const next = after.providerHandleChain[index]!
      return (
        link.linkId === next.linkId &&
        link.handle.agent === next.handle.agent &&
        link.handle.nativeId === next.handle.nativeId
      )
    })
  )
}
