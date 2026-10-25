import { normalizeAgentSessionConversationName } from '../../shared/agent-session/agent-session-conversation-name'
import type { AgentSessionRecord } from '../../shared/agent-session-record'

/** Names are durable metadata, not ownership; normalize without contending on the writer fence. */
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

export async function compareAndSetAgentSessionRecordName(
  mutate: (
    apply: (record: AgentSessionRecord) => AgentSessionRecord
  ) => Promise<AgentSessionRecord>,
  name: string | null,
  expected: string | null
): Promise<AgentSessionRecord | null> {
  let matched = false
  const record = await mutate((current) => {
    matched = (current.conversationName ?? null) === expected
    return matched ? setAgentSessionRecordConversationName(current, name, Date.now()) : current
  })
  return matched ? record : null
}

export type CompareAndSetConversationName = (
  sessionId: string,
  name: string | null,
  expected: string | null
) => Promise<AgentSessionRecord | null>
