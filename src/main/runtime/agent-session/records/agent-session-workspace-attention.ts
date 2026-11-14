import type { StructuredAttentionRead } from '../../../../shared/agent-session/agent-session-attention'
import type { AgentSessionConversationView } from '../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import {
  agentSessionExecutionLocationsEqual,
  type AgentSessionExecutionLocation
} from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { JournalSqlDatabase } from '../../../native-chat/agent-session-journal/database/journal-sql-database'

/** Each saved chat in this workspace reports its committed cursor without opening it. */
export async function readAgentSessionWorkspaceAttention(
  database: JournalSqlDatabase,
  conversations: readonly AgentSessionConversationView[],
  location: AgentSessionExecutionLocation
): Promise<(StructuredAttentionRead & { scope: AgentSessionExecutionLocation })[]> {
  const reads = await Promise.all(
    conversations
      .filter((conversation) =>
        agentSessionExecutionLocationsEqual(conversation.location, location)
      )
      .map(async ({ sessionId, location: scope }) => {
        try {
          if ((await database.ensureSessionEpoch(sessionId)) === null) {
            return null
          }
          const head = await database.readers.point({ sessionId, operation: { kind: 'metadata' } })
          return head.kind === 'metadata'
            ? { sessionId, scope: { ...scope }, observedCursor: head.cursor }
            : null
        } catch (error) {
          console.warn('[notifications] Could not capture workspace attention boundary', {
            sessionId,
            error
          })
          return null
        }
      })
  )
  return reads.flatMap((read) => (read ? [read] : []))
}
