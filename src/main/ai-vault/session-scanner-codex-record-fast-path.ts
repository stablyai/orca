// Records below this size are decoded and parsed exactly: JSON.parse on a
// kilobyte costs less than the risk of a prefix heuristic, and the scan cost
// this path exists to remove is entirely in megabyte-scale records.
const CODEX_RECORD_PREFIX_LIMIT = 1024
// serde emits `RolloutLine` as `timestamp` then the adjacently tagged
// `RolloutItem` (`type`, `payload`), and every tagged payload enum writes its
// own `type` first. Anything spelled differently takes the full parser.
const CODEX_RECORD_ENVELOPE_PATTERN = /^\{"timestamp":"([^"]+)","type":"([^"]+)","payload":/
const CODEX_PAYLOAD_TYPE_PATTERN = /^\{"type":"([^"]+)"/

// Every record `consumeCodexRecordLine` reads beyond the timeline clock; the
// fast path is the complement, so teaching the parser a new record means
// adding it here or the scanner silently stops seeing it.
// `session-scanner-codex-fast-path.test.ts` pins each entry.
const PARSED_RECORD_TYPES = new Set(['session_meta', 'turn_context'])
const PARSED_RESPONSE_ITEM_TYPES = new Set(['message'])
const PARSED_EVENT_TYPES = new Set([
  'item_completed',
  'user_message',
  'agent_message',
  'token_count'
])

/** Returns the timestamp only when the record cannot affect other visible session fields. */
export function readCodexTimelineOnlyRecord(line: Buffer): { timestamp: string } | null {
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
  // A payload whose type is unreadable from the bounded prefix stays ambiguous.
  const payloadType = CODEX_PAYLOAD_TYPE_PATTERN.exec(prefix.slice(envelope[0].length))?.[1]
  if (!payloadType) {
    return null
  }
  const parsedPayloadTypes =
    recordType === 'response_item' ? PARSED_RESPONSE_ITEM_TYPES : PARSED_EVENT_TYPES
  return parsedPayloadTypes.has(payloadType) ? null : { timestamp }
}
