import { normalizeAgentSessionConversationName } from '../../shared/agent-session-conversation-name'
import type { AgentSessionRecord } from '../../shared/agent-session-record'

/**
 * Set or clear the conversation name on one record.
 *
 * Deliberately unfenced: the name is a durable note, not ownership, so writing it never contends
 * with the writer lease. Normalizing here — the only writer of the field — keeps the record's own
 * validator satisfied no matter which caller supplied the text.
 */
export function setAgentSessionRecordConversationName(
  record: AgentSessionRecord,
  name: string | null,
  now: number
): AgentSessionRecord {
  const normalized = name === null ? null : normalizeAgentSessionConversationName(name)
  if ((record.conversationName ?? null) === normalized) {
    return record
  }
  const next = { ...record, updatedAt: now }
  if (normalized === null) {
    delete next.conversationName
    return next
  }
  next.conversationName = normalized
  return next
}
