/**
 * Read one stored agent-session record, repairing recoverable optional metadata before validation.
 *
 * Quarantine is whole-record: a rejected row loses its lease, its options and its provider-handle
 * chain, not only the field that failed. `conversationName` is validated against its canonical
 * normalization, so widening the normalizer by one codepoint would retroactively invalidate every
 * name already on disk — and take those sessions with it. Repairing the field to canonical form
 * keeps the record, and keeps the durable "Orca already named this session" marker that stops a
 * later acquisition from spending another model call on a name it already has.
 *
 * Identity and ownership stay out of reach: an invalid lease, session id or handle chain still
 * quarantines the whole record, because nothing here can tell what the right value would have been.
 */

import {
  isAgentSessionConversationName,
  normalizeAgentSessionConversationName
} from '../../shared/agent-session-conversation-name'
import {
  AGENT_SESSION_RECORD_SCHEMA_VERSION,
  isAgentSessionRecord,
  type AgentSessionRecord
} from '../../shared/agent-session-record'

export type AgentSessionRecordReadResult =
  | { record: AgentSessionRecord; repaired: boolean }
  | { record: null; reason: string }

/** Repaired shallow copy, or null when the stored field is already canonical or absent. The
 *  original object is left untouched so a row that fails validation anyway quarantines verbatim. */
function repairConversationName(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  const stored = value as Record<string, unknown>
  if (!Object.hasOwn(stored, 'conversationName')) {
    return null
  }
  // Use the validator's clause before normalizing so null cannot masquerade as canonical absence.
  if (
    stored.conversationName === undefined ||
    isAgentSessionConversationName(stored.conversationName)
  ) {
    return null
  }
  const normalized = normalizeAgentSessionConversationName(stored.conversationName)
  const repaired = { ...stored }
  if (normalized === null) {
    delete repaired.conversationName
  } else {
    repaired.conversationName = normalized
  }
  return repaired
}

export function readAgentSessionRecord(
  sessionId: string,
  value: unknown
): AgentSessionRecordReadResult {
  const repaired = repairConversationName(value)
  const candidate: unknown = repaired ?? value
  const record = isAgentSessionRecord(candidate) ? candidate : null
  if (record?.sessionId === sessionId) {
    return { record, repaired: repaired !== null }
  }
  const storedSchemaVersion =
    typeof value === 'object' &&
    value !== null &&
    (value as { schemaVersion?: unknown }).schemaVersion
  return {
    record: null,
    reason: record
      ? 'record_key_session_id_mismatch'
      : storedSchemaVersion === AGENT_SESSION_RECORD_SCHEMA_VERSION
        ? 'current_shape_invalid'
        : 'unsupported_schema'
  }
}
