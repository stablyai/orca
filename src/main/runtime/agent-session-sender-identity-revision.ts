import { agentSessionScopeKey, type AgentSessionRecord } from '../../shared/agent-session-record'
import type { AgentSessionStoreState } from './agent-session-store-state'
import type { AgentSessionStoreRowWrites } from './agent-session-store-draft'

function senderFacts(record: AgentSessionRecord | undefined): string | undefined {
  if (!record) {
    return undefined
  }
  const command = record.conversationCommand
  const clearedInto =
    command?.command === 'clear' && command.phase === 'committed'
      ? (command.replacementSessionId ?? null)
      : null
  return JSON.stringify([agentSessionScopeKey(record.location), clearedInto])
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
