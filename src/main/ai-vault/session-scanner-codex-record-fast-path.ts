import { CODEX_TOOL_RESPONSE_TYPES } from './session-scanner-codex-tool-records'

// Restrict prefix heuristics to large records, where full JSON parsing dominates scan cost.
const CODEX_RECORD_PREFIX_LIMIT = 1024
// Match serde ordering (timestamp/type/payload, payload type first); other spellings need full parsing.
const CODEX_RECORD_ENVELOPE_PATTERN = /^\{"timestamp":"([^"]+)","type":"([^"]+)","payload":/
const CODEX_PAYLOAD_TYPE_PATTERN = /^\{"type":"([^"]+)"/

// Keep these sets in sync with consumeCodexRecordLine or the fast path will silently discard new fields.
const PARSED_RECORD_TYPES = new Set(['session_meta', 'turn_context'])
const PARSED_RESPONSE_ITEM_TYPES = new Set(['message'])
const PARSED_EVENT_TYPES = new Set([
  'item_completed',
  'user_message',
  'agent_message',
  'token_count'
])

/** Returns the timestamp only when the record cannot affect other visible session fields. */
export function readCodexTimelineOnlyRecord(
  line: Buffer,
  includeTools = false
): { timestamp: string } | null {
  if (line.length <= CODEX_RECORD_PREFIX_LIMIT) {
    return null
  }
  const prefix = line.toString('utf8', 0, CODEX_RECORD_PREFIX_LIMIT)
  const envelope = CODEX_RECORD_ENVELOPE_PATTERN.exec(prefix)
  const timestamp = envelope?.[1]
  const recordType = envelope?.[2]
  if (!timestamp || !recordType || PARSED_RECORD_TYPES.has(recordType)) {
    return null
  }
  if (recordType !== 'response_item' && recordType !== 'event_msg') {
    return { timestamp }
  }
  const payloadType = CODEX_PAYLOAD_TYPE_PATTERN.exec(prefix.slice(envelope[0].length))?.[1]
  if (!payloadType) {
    return null
  }
  if (
    includeTools &&
    recordType === 'response_item' &&
    CODEX_TOOL_RESPONSE_TYPES.has(payloadType)
  ) {
    return null
  }
  const parsedPayloadTypes =
    recordType === 'response_item' ? PARSED_RESPONSE_ITEM_TYPES : PARSED_EVENT_TYPES
  return parsedPayloadTypes.has(payloadType) ? null : { timestamp }
}
