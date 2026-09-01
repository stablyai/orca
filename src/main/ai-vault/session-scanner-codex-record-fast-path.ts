const CODEX_RECORD_PREFIX_LIMIT = 1024
const CODEX_RECORD_ENVELOPE_PATTERN = /^\{"timestamp":"([^"]+)","type":"([^"]+)","payload":/
const CODEX_PAYLOAD_TYPE_PATTERN = /^\{"type":"([^"]+)"/
const TIMELINE_ONLY_RESPONSE_ITEM_TYPES = new Set([
  'function_call_output',
  'custom_tool_call_output',
  'reasoning',
  'custom_tool_call',
  'function_call',
  'tool_search_output'
])
const TIMELINE_ONLY_EVENT_TYPES = new Set([
  'patch_apply_end',
  'task_complete',
  'task_started',
  'thread_settings_applied',
  'context_compacted',
  'turn_aborted'
])

/** Returns the timestamp only when the record cannot affect other visible session fields. */
export function readCodexTimelineOnlyRecord(line: Buffer): { timestamp: string } | null {
  const prefix = line.toString('utf8', 0, Math.min(line.length, CODEX_RECORD_PREFIX_LIMIT))
  const envelope = CODEX_RECORD_ENVELOPE_PATTERN.exec(prefix)
  const timestamp = envelope?.[1]
  const recordType = envelope?.[2]
  if (!timestamp || !recordType) {
    return null
  }

  const payloadType = CODEX_PAYLOAD_TYPE_PATTERN.exec(prefix.slice(envelope[0].length))?.[1]
  if (recordType === 'response_item') {
    return payloadType && TIMELINE_ONLY_RESPONSE_ITEM_TYPES.has(payloadType) ? { timestamp } : null
  }
  if (recordType === 'event_msg') {
    return payloadType && TIMELINE_ONLY_EVENT_TYPES.has(payloadType) ? { timestamp } : null
  }
  return recordType === 'compacted' || recordType === 'world_state' ? { timestamp } : null
}
