import {
  agentSessionScopeKey,
  type AgentSessionRecord
} from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentSessionConversationView } from '../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import type { AgentSessionStoreState } from './agent-session-store-state'
import type { AgentSessionStoreRowWrites } from '../../../native-chat/agent-session-journal/journal-writer-store-row-changes'

/** The session a committed /clear continued this one in: the durable forward pointer. */
export function clearSuccessor(
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
