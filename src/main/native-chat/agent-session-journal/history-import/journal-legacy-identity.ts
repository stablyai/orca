// Read identity from the same raw line as content. Claude UUIDs survive forks; other legacy IDs
// are import-scoped because rollout IDs lack stable structured turn/ordinal identity.

import type { AgentType } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { NativeChatTranscriptAgent } from '../../../../shared/native-chat/native-chat-agent-support'

export type LegacyIdentityTracker = {
  /** Observe every raw line, including discarded ones, to keep decoder identities aligned. */
  identify(record: Record<string, unknown> | null, lineIndex: number): AgentJournalItemIdentity
}

export function createLegacyIdentityTracker(input: {
  transcriptAgent: NativeChatTranscriptAgent
  agent: AgentType
  sessionId: string
}): LegacyIdentityTracker {
  if (input.transcriptAgent === 'claude') {
    return {
      identify: (record, index) => claudeIdentity(record, index, input.agent, input.sessionId)
    }
  }
  return {
    identify: (record, index) => ({
      provider: 'legacy',
      agent: input.agent,
      sessionId: input.sessionId,
      recordId: legacyRecordId(record, index, input.transcriptAgent === 'codex')
    })
  }
}

function claudeIdentity(
  record: Record<string, unknown> | null,
  lineIndex: number,
  agent: AgentType,
  sessionId: string
): AgentJournalItemIdentity {
  const uuid = stringField(record, 'uuid')
  if (!uuid) {
    return { provider: 'legacy', agent, sessionId, recordId: `#${lineIndex}` }
  }
  // Forks retain original item UUIDs; using the fork session ID would duplicate identities.
  return { provider: 'claude', sessionId: stringField(record, 'sessionId') ?? sessionId, uuid }
}

/** Line position is stable only within a given import; prefer stored IDs when available. */
function legacyRecordId(
  record: Record<string, unknown> | null,
  lineIndex: number,
  nestedItem: boolean
): string {
  const payload = record?.payload
  const item =
    nestedItem && payload && typeof payload === 'object' && 'item' in payload ? payload.item : null
  const id =
    stringField(item, 'id') ??
    stringField(payload, 'id') ??
    stringField(record, 'id') ??
    stringField(record, 'uuid')
  return id ?? `#${lineIndex}`
}

function stringField(source: unknown, key: string): string | null {
  if (!source || typeof source !== 'object') {
    return null
  }
  const value = (source as Record<string, unknown>)[key]
  return typeof value === 'string' && value ? value : null
}
