import { agentSessionScopeKey, type AgentSessionRecord } from '../../shared/agent-session-record'
import type { AgentSessionConversationView } from '../../shared/agent-session-conversation-view'
import { heldAgentSessionIds, type AgentSessionStoreState } from './agent-session-store-state'
import type { AgentSessionStoreRowWrites } from './agent-session-store-draft'

/** The session a committed /clear continued this one in: the durable forward pointer. */
function clearSuccessor(
  record: Pick<AgentSessionConversationView, 'conversationCommand'> | null | undefined
): string | null {
  const command = record?.conversationCommand
  return command?.command === 'clear' && command.phase === 'committed'
    ? (command.replacementSessionId ?? null)
    : null
}

function senderFacts(record: AgentSessionRecord | undefined): string | undefined {
  return record
    ? JSON.stringify([agentSessionScopeKey(record.location), clearSuccessor(record)])
    : undefined
}

/** Which sessions a committed /clear continued into each one: the reverse of the saved forward
 *  pointer, so a sender read reaches an open chat's predecessors without listing all history.
 *  Derived from every held row at load and kept for the rows each commit writes; never saved. */
export class AgentSessionClearedFromIndex {
  private readonly into = new Map<string, string>()
  private readonly from = new Map<string, Set<string>>()

  constructor(state: AgentSessionStoreState) {
    this.update(state, heldAgentSessionIds(state))
  }

  /** Re-read only these rows' pointers; a removed row falls back to what the store still holds. */
  update(state: AgentSessionStoreState, sessionIds: Iterable<string>): void {
    for (const id of sessionIds) {
      // The pointer straight from the held row; no conversation view is built for it.
      const next = clearSuccessor(
        state.records.get(id) ?? state.unreadableRecords.get(id)?.conversation
      )
      const previous = this.into.get(id)
      if (previous === next) {
        continue
      }
      if (previous !== undefined) {
        const set = this.from.get(previous)
        set?.delete(id)
        if (set?.size === 0) {
          this.from.delete(previous)
        }
        this.into.delete(id)
      }
      if (next !== null) {
        this.into.set(id, next)
        this.from.set(next, (this.from.get(next) ?? new Set()).add(id))
      }
    }
  }

  predecessors(sessionId: string): readonly string[] {
    return [...(this.from.get(sessionId) ?? [])]
  }
}

/** Whether a commit changed what chat sender identity reads: which chats exist, where they run,
 *  their committed /clear successor, or which have open tabs. Lease renewals and receipts don't. */
export function changesAgentSenderIdentity(
  published: AgentSessionStoreState,
  draft: AgentSessionStoreState,
  writes: AgentSessionStoreRowWrites
): boolean {
  return (
    writes.sessionTabs !== null ||
    writes.records.remove.length > 0 ||
    writes.records.upsert.some(
      ([sessionId]) =>
        senderFacts(published.records.get(sessionId)) !== senderFacts(draft.records.get(sessionId))
    )
  )
}
