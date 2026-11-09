// Read identity from the same raw line as content. Claude UUIDs survive forks; other legacy IDs
// are import-scoped because rollout IDs lack stable structured turn/ordinal identity.

import type { AgentType } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { NativeChatTranscriptAgent } from '../../../../shared/native-chat/native-chat-agent-support'

export type LegacyIdentityTracker = {
  /** Observe every raw line, including discarded ones, to keep decoder identities aligned. */
  identify(line: string, lineIndex: number): AgentJournalItemIdentity
}

export function resolveDecodedLegacyMessageIdentity(
  tracker: LegacyIdentityTracker,
  line: string,
  lineIndex: number,
  input: {
    agent: AgentType
    sessionId: string
    messageId: string
    role: string
    splitLine: boolean
    recordId?: string
    decodedMessageIdentities?: true
  }
): AgentJournalItemIdentity {
  if (input.recordId || input.decodedMessageIdentities) {
    return {
      provider: 'legacy',
      agent: input.agent,
      sessionId: input.sessionId,
      recordId: input.recordId ?? input.messageId
    }
  }
  const tracked = tracker.identify(line, lineIndex)
  if (
    input.splitLine &&
    tracked.provider === 'legacy' &&
    input.role === 'reasoning' &&
    !tracked.recordId.endsWith(':reasoning')
  ) {
    return { ...tracked, recordId: `${tracked.recordId}:reasoning` }
  }
  return tracked
}

export function createLegacyIdentityTracker(input: {
  transcriptAgent: NativeChatTranscriptAgent
  agent: AgentType
  sessionId: string
}): LegacyIdentityTracker {
  if (input.transcriptAgent === 'claude') {
    return { identify: (line, index) => claudeIdentity(line, index, input.agent, input.sessionId) }
  }
  const seenRecordIds = new Set<string>()
  let cachedLineIndex = -1
  let cachedRecordId = ''
  return {
    identify: (line, index) => {
      if (index !== cachedLineIndex) {
        cachedLineIndex = index
        cachedRecordId = uniqueLegacyRecordId(
          line,
          index,
          input.transcriptAgent === 'codex',
          seenRecordIds
        )
      }
      return {
        provider: 'legacy',
        agent: input.agent,
        sessionId: input.sessionId,
        recordId: cachedRecordId
      }
    }
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

function uniqueLegacyRecordId(
  line: string,
  lineIndex: number,
  nestedItem: boolean,
  seenRecordIds: Set<string>
): string {
  const baseId = legacyRecordId(line, lineIndex, nestedItem)
  const recordId = seenRecordIds.has(baseId) ? `${baseId}#${lineIndex}` : baseId
  seenRecordIds.add(recordId)
  return recordId
}
function legacyRecordId(line: string, lineIndex: number, nestedItem: boolean): string {
  const record = parseRecord(line)
  const payload = record?.payload
  const item =
    nestedItem && payload && typeof payload === 'object' && 'item' in payload ? payload.item : null
  const stepIndex = record?.step_index
  const id =
    stringField(item, 'id') ??
    stringField(payload, 'id') ??
    stringField(record, 'id') ??
    stringField(record, 'uuid') ??
    (typeof stepIndex === 'number' && Number.isSafeInteger(stepIndex) && stepIndex >= 0
      ? `step-${stepIndex}`
      : null)
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
