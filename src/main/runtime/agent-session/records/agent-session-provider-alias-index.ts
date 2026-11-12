import type { AgentSessionConversationView } from '../../../../shared/agent-session/lifecycle/agent-session-conversation-view'
import {
  getAgentSessionConversation,
  listAgentSessionConversations,
  type AgentSessionStoreState
} from './agent-session-store-state'

/** Provider-native session ids of the loaded chats, mapped to the chats whose handle chains name
 *  them: built once per store authority, then kept by committed record writes, so a recipient's
 *  provider-id question never walks the history. Derived only; nothing is saved. */
export class AgentSessionProviderAliasIndex {
  private readonly owners = new Map<string, Set<string>>()
  private readonly aliasesBySession = new Map<string, readonly string[]>()

  constructor(state: AgentSessionStoreState) {
    for (const view of listAgentSessionConversations(state)) {
      this.add(view)
    }
  }

  /** Follows one committed transaction: only the written records' old and new aliases move. */
  applyCommitted(
    draft: AgentSessionStoreState,
    records: { upsert: readonly (readonly [string, string])[]; remove: readonly string[] }
  ): void {
    for (const sessionId of [...records.upsert.map(([id]) => id), ...records.remove]) {
      this.remove(sessionId)
      const view = getAgentSessionConversation(draft, sessionId)
      if (view) {
        this.add(view)
      }
    }
  }

  /** The chat naming `nativeId`; with several, the first in listing order, as a full scan picks. */
  owner(nativeId: string, state: AgentSessionStoreState): string | null {
    const owners = this.owners.get(nativeId)
    if (!owners || owners.size === 0) {
      return null
    }
    if (owners.size === 1) {
      return owners.values().next().value ?? null
    }
    for (const sessionId of state.records.keys()) {
      if (owners.has(sessionId)) {
        return sessionId
      }
    }
    for (const [sessionId, row] of state.unreadableRecords) {
      if (row.conversation && owners.has(sessionId)) {
        return sessionId
      }
    }
    return null
  }

  private add(view: AgentSessionConversationView): void {
    const aliases = view.providerHandleChain.map(({ handle }) => handle.nativeId)
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
