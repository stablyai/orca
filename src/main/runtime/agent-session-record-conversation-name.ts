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

/** How a user's name write lands: `rename` always wins; `legacy-alias` (a window's tab rename
 *  from before names were saved here) only replaces a name Orca chose, so a late or replayed
 *  upload never overwrites a rename the user made since. */
export type AgentSessionUserNameWrite = 'rename' | 'legacy-alias'

export function setAgentSessionRecordUserName(
  record: AgentSessionRecord,
  name: string,
  write: AgentSessionUserNameWrite,
  now: number
): { record: AgentSessionRecord; applied: boolean } {
  const normalized = normalizeAgentSessionConversationName(name)
  if (
    normalized === null ||
    (write === 'legacy-alias' && record.conversationNameSource === 'user')
  ) {
    return { record, applied: false }
  }
  if (record.conversationName === normalized && record.conversationNameSource === 'user') {
    return { record, applied: true }
  }
  return {
    record: {
      ...record,
      conversationName: normalized,
      conversationNameSource: 'user',
      updatedAt: now
    },
    applied: true
  }
}

export async function setAgentSessionRecordUserNameThrough(
  mutate: (
    apply: (record: AgentSessionRecord) => AgentSessionRecord
  ) => Promise<AgentSessionRecord>,
  name: string,
  write: AgentSessionUserNameWrite
): Promise<{ record: AgentSessionRecord; applied: boolean }> {
  let applied = false
  const record = await mutate((current) => {
    const result = setAgentSessionRecordUserName(current, name, write, Date.now())
    applied = result.applied
    return result.record
  })
  return { record, applied }
}

/** Automatic naming's write: applies only while the name is still `expected` and the user has not
 *  named the conversation, so a stale generation never replaces a rename — even one back to the
 *  same text. */
export async function compareAndSetAgentSessionRecordName(
  mutate: (
    apply: (record: AgentSessionRecord) => AgentSessionRecord
  ) => Promise<AgentSessionRecord>,
  name: string | null,
  expected: string | null
): Promise<AgentSessionRecord | null> {
  let matched = false
  const record = await mutate((current) => {
    matched =
      current.conversationNameSource !== 'user' && (current.conversationName ?? null) === expected
    return matched ? setAgentSessionRecordConversationName(current, name, Date.now()) : current
  })
  return matched ? record : null
}

export type CompareAndSetConversationName = (
  sessionId: string,
  name: string | null,
  expected: string | null
) => Promise<AgentSessionRecord | null>
