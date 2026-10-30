// Read identity from the same raw line as content. Claude UUIDs survive forks; other legacy IDs
// are import-scoped because rollout IDs lack stable structured turn/ordinal identity.

import type { AgentType } from '../../../shared/agent-status-types'
import type { AgentJournalItemIdentity } from '../../../shared/agent-session-journal-types'
import type { NativeChatTranscriptAgent } from '../../../shared/native-chat-agent-support'

export type LegacyIdentityTracker = {
  /** Observe every raw line, including discarded ones, to keep decoder identities aligned. */
  identify(line: string, lineIndex: number): AgentJournalItemIdentity
}

export function createLegacyIdentityTracker(input: {
  transcriptAgent: NativeChatTranscriptAgent
  agent: AgentType
  sessionId: string
}): LegacyIdentityTracker {
  if (input.transcriptAgent === 'claude') {
    return { identify: (line, index) => claudeIdentity(line, index, input.agent, input.sessionId) }
  }
  return {
    identify: (line, index) => ({
      provider: 'legacy',
      agent: input.agent,
      sessionId: input.sessionId,
      recordId: legacyRecordId(line, index)
    })
  }
}

function claudeIdentity(
  line: string,
  lineIndex: number,
  agent: AgentType,
  sessionId: string
): AgentJournalItemIdentity {
  const record = parseRecord(line)
  const uuid = stringField(record, 'uuid')
  if (!uuid) {
    return { provider: 'legacy', agent, sessionId, recordId: `#${lineIndex}` }
  }
  // Forks retain original item UUIDs; using the fork session ID would duplicate identities.
  return { provider: 'claude', sessionId: stringField(record, 'sessionId') ?? sessionId, uuid }
}

/** Line position is stable only within a given import; prefer stored IDs when available. */
function legacyRecordId(line: string, lineIndex: number): string {
  const record = parseRecord(line)
  const payload = record?.payload
  const id = stringField(payload, 'id') ?? stringField(record, 'id') ?? stringField(record, 'uuid')
  return id ?? `#${lineIndex}`
}

function parseRecord(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function stringField(source: unknown, key: string): string | null {
  if (!source || typeof source !== 'object') {
    return null
  }
  const value = (source as Record<string, unknown>)[key]
  return typeof value === 'string' && value ? value : null
}
