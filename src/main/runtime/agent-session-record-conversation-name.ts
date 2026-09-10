import type { AgentSessionRecord } from '../../shared/agent-session-record'

/**
 * Records the provider's name for a conversation, or clears it.
 *
 * Unfenced on purpose: a name is display metadata, not ownership, so a reader
 * that learned it must not have to win the lease to keep it. An unchanged value
 * is returned as-is, so the RECORD is not rewritten — the store still opens a
 * transaction, so callers skip the call rather than relying on this.
 *
 * `null` clears: a user who deletes the name in another client must not have it
 * linger here and keep rendering.
 */
export function setAgentSessionRecordConversationName(
  record: AgentSessionRecord,
  conversationName: string | null,
  now: number
): AgentSessionRecord {
  if (conversationName === null) {
    if (record.conversationName === undefined) {
      return record
    }
    const { conversationName: _cleared, ...rest } = record
    return { ...rest, updatedAt: now }
  }
  return record.conversationName === conversationName
    ? record
    : { ...record, conversationName, updatedAt: now }
}

/** Marks that a naming attempt has been made, so no later session repeats it. */
export function markAgentSessionRecordConversationNamingAttempted(
  record: AgentSessionRecord,
  now: number
): AgentSessionRecord {
  return record.conversationNamingAttempted === true
    ? record
    : { ...record, conversationNamingAttempted: true, updatedAt: now }
}

/** What one naming update changes: the name, the attempted marker, or both. */
export type AgentSessionConversationNamingChange = {
  /** A string sets the name; `null` clears it; omitted leaves it alone. */
  conversationName?: string | null
  attempted?: true
}

export function applyAgentSessionRecordConversationNaming(
  record: AgentSessionRecord,
  change: AgentSessionConversationNamingChange,
  now: number
): AgentSessionRecord {
  const named =
    change.conversationName === undefined
      ? record
      : setAgentSessionRecordConversationName(record, change.conversationName, now)
  return change.attempted ? markAgentSessionRecordConversationNamingAttempted(named, now) : named
}
