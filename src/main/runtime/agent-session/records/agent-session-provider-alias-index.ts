import type { AgentSessionConversationView } from '../../../../shared/agent-session/lifecycle/agent-session-conversation-view'
import {
  getAgentSessionConversation,
  listAgentSessionConversations,
  type AgentSessionStoreState
} from './agent-session-store-state'
import { AgentSessionDraftRecords } from './agent-session-store-draft'
import { structuredAgentRuntimeMetadata } from '../installation/structured-agent-runtime-metadata'

/** Provider-native session ids of the loaded chats, mapped to the chats whose handle chains name
 *  them: built once per store authority, then kept by committed record writes, so a recipient's
 *  provider-id question never walks the history. Derived only; nothing is saved. */
export class AgentSessionProviderAliasIndex {
  private readonly owners = new Map<string, Set<string>>()
  private readonly aliasesBySession = new Map<string, readonly string[]>()
  /** Each chat's place in listing order (readable records, then unreadable ones), mirrored from
   *  the store's maps so a shared alias picks its owner among its owners alone. */
  private readonly readableOrder = new Map<string, number>()
  private readonly unreadableOrder = new Map<string, number>()
  private nextReadable = 0

  constructor(state: AgentSessionStoreState) {
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

  /** Follows one committed transaction: only the written records' places and aliases move. */
  applyCommitted(
    draft: AgentSessionStoreState,
    records: { upsert: readonly (readonly [string, string])[]; remove: readonly string[] }
  ): void {
    // Keys the draft appended take the end, in its order; every other key keeps its place.
    const appended =
      draft.records instanceof AgentSessionDraftRecords
        ? draft.records.appended
        : records.upsert.map(([id]) => id).filter((id) => !this.readableOrder.has(id))
    for (const sessionId of appended) {
      this.readableOrder.delete(sessionId)
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

  /** The chat naming `nativeId`; with several, the first in listing order, as a full scan picks. */
  owner(nativeId: string): string | null {
    let first: string | null = null
    for (const sessionId of this.owners.get(`native\0${nativeId}`) ?? []) {
      if (first === null || this.precedes(sessionId, first)) {
        first = sessionId
      }
    }
    return first
  }

  /** Only matching chats, in the same order as listConversations. */
  matchingHistoryOwners(rowSessionId: string): string[] {
    return [...(this.owners.get(`history\0${rowSessionId}`) ?? [])].sort((a, b) =>
      a === b ? 0 : this.precedes(a, b) ? -1 : 1
    )
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
    const history = structuredAgentRuntimeMetadata(view.provider)?.sessionHistory
    const aliases = view.providerHandleChain.flatMap((link) => [
      `native\0${link.handle.nativeId}`,
      ...(history ? [`history\0${history.rowSessionId(link)}`] : [])
    ])
    this.aliasesBySession.set(view.sessionId, aliases)
    for (const alias of aliases) {
      const owners = this.owners.get(alias) ?? new Set<string>()
      owners.add(view.sessionId)
      this.owners.set(alias, owners)
    }
  }

  private remove(sessionId: string): void {
    for (const alias of this.aliasesBySession.get(sessionId) ?? []) {
      const owners = this.owners.get(alias)
      owners?.delete(sessionId)
      if (owners?.size === 0) {
        this.owners.delete(alias)
      }
    }
    this.aliasesBySession.delete(sessionId)
  }
}
