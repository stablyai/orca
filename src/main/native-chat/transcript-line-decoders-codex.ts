import {
  NATIVE_CHAT_INTERRUPTED_STATUS_TEXT,
  type NativeChatMessage
} from '../../shared/native-chat/native-chat-types'
import { NATIVE_CHAT_NOTICE_COPY } from '../../shared/native-chat/native-chat-notice'
import {
  asRecord,
  extractString,
  parseJsonObject,
  timestampMs
} from '../ai-vault/session-scanner-values'
import { claudeContentBlocksWork } from './transcript-record-blocks'
import {
  codexTurnItemBlocks,
  codexToolResult,
  codexSummaryText,
  withoutSkillContext
} from './transcript-codex-content'
import { finishTranscriptWork, type TranscriptWork } from './transcript-work-scheduler'
import { CODEX_EVENT_TURN_ABORTED } from './transcript-turn-markers'

/** Paginated completed items own visible messages; response tools retain their legacy format. */
export function isCodexVisibleHistoryRecord(
  record: Record<string, unknown> | null,
  paginated: boolean
): boolean {
  const payload = asRecord(record?.payload)
  return (
    !paginated ||
    !(
      (record?.type === 'response_item' &&
        (payload?.type === 'message' || payload?.type === 'reasoning')) ||
      (record?.type === 'event_msg' &&
        (payload?.type === 'user_message' || payload?.type === 'agent_message'))
    )
  )
}

export function decodeCodexTranscriptLine(
  line: string,
  fallbackId: string,
  options?: { historyImport: true }
): NativeChatMessage | null {
  return decodeCodexTranscriptRecord(parseJsonObject(line), fallbackId, options)
}

export function decodeCodexTranscriptRecord(
  record: Record<string, unknown> | null,
  fallbackId: string,
  options?: { historyImport: true }
): NativeChatMessage | null {
  return finishTranscriptWork(decodeCodexTranscriptRecordWork(record, fallbackId, options))
}

export function* decodeCodexTranscriptRecordWork(
  record: Record<string, unknown> | null,
  fallbackId: string,
  options?: { historyImport: true }
): TranscriptWork<NativeChatMessage | null> {
  if (!record) {
    return null
  }
  const payload = asRecord(record.payload)
  if (!payload) {
    const id = extractString(record.id) ?? fallbackId
    return yield* codexUnwrappedResponseItem(record, id, parseTimestamp(record.timestamp))
  }
  const timestamp = parseTimestamp(record.timestamp)
  const baseId = extractString(payload.id) ?? fallbackId

  if (record.type === 'response_item') {
    return yield* codexResponseItem(payload, baseId, timestamp)
  }
  if (record.type === 'event_msg') {
    return yield* codexEventMessage(payload, baseId, timestamp, options?.historyImport === true)
  }
  return null
}

function* codexUnwrappedResponseItem(
  record: Record<string, unknown>,
  id: string,
  timestamp: number | null
): TranscriptWork<NativeChatMessage | null> {
  if (record.type !== 'message') {
    return yield* codexResponseItem(record, id, timestamp)
  }
  const role = record.role === 'assistant' ? 'assistant' : record.role === 'user' ? 'user' : null
  const decodedBlocks = yield* codexTurnItemBlocks(record.content)
  const blocks = role === 'user' ? yield* withoutSkillContext(decodedBlocks) : decodedBlocks
  return role && blocks.length > 0 ? { id, role, blocks, timestamp, source: 'transcript' } : null
}

function* codexResponseItem(
  payload: Record<string, unknown>,
  id: string,
  timestamp: number | null
): TranscriptWork<NativeChatMessage | null> {
  if (payload.type === 'message') {
    const role =
      payload.role === 'assistant' ? 'assistant' : payload.role === 'user' ? 'user' : null
    if (!role) {
      return null
    }
    const decodedBlocks = yield* claudeContentBlocksWork(payload.content)
    const blocks = role === 'user' ? yield* withoutSkillContext(decodedBlocks) : decodedBlocks
    if (blocks.length === 0) {
      return null
    }
    return { id, role, blocks, timestamp, source: 'transcript' }
  }
  if (payload.type === 'reasoning') {
    const text = extractString(payload.text) ?? (yield* codexSummaryText(payload.summary))
    if (!text) {
      return null
    }
    return {
      id,
      role: 'reasoning',
      blocks: [{ type: 'text', text }],
      timestamp,
      source: 'transcript'
    }
  }
  if (
    payload.type === 'function_call' ||
    payload.type === 'local_shell_call' ||
    payload.type === 'custom_tool_call'
  ) {
    const name = extractString(payload.name) ?? 'tool'
    const callId = extractString(payload.call_id)
    return {
      id,
      role: 'assistant',
      blocks: [
        { type: 'tool-call', name, input: codexCallInput(payload), ...(callId ? { callId } : {}) }
      ],
      timestamp,
      source: 'transcript'
    }
  }
  if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
    return {
      id,
      role: 'tool',
      blocks: [yield* codexToolResult(payload.output, extractString(payload.call_id))],
      timestamp,
      source: 'transcript'
    }
  }
  return null
}

function* codexEventMessage(
  payload: Record<string, unknown>,
  id: string,
  timestamp: number | null,
  historyImport: boolean
): TranscriptWork<NativeChatMessage | null> {
  if (payload.type === CODEX_EVENT_TURN_ABORTED) {
    return {
      id,
      role: 'system',
      blocks: [{ type: 'text', text: NATIVE_CHAT_INTERRUPTED_STATUS_TEXT }],
      timestamp,
      source: 'transcript'
    }
  }
  // Legacy rollouts persist this event; paginated rollouts persist a ContextCompaction item instead.
  if (payload.type === 'context_compacted') {
    return codexCompactionMarker(id, timestamp)
  }
  if (payload.type === 'item_completed') {
    return yield* codexCompletedTurnItem(payload, id, timestamp, historyImport)
  }
  if (payload.type === 'user_message') {
    const text = extractString(payload.message)
    return text
      ? { id, role: 'user', blocks: [{ type: 'text', text }], timestamp, source: 'transcript' }
      : null
  }
  if (payload.type === 'agent_message') {
    const text = extractString(payload.message)
    return text
      ? { id, role: 'assistant', blocks: [{ type: 'text', text }], timestamp, source: 'transcript' }
      : null
  }
  return null
}

function* codexCompletedTurnItem(
  payload: Record<string, unknown>,
  fallbackId: string,
  timestamp: number | null,
  historyImport: boolean
): TranscriptWork<NativeChatMessage | null> {
  const item = asRecord(payload.item)
  if (!item) {
    return null
  }
  const id = extractString(item.id) ?? fallbackId
  if (historyImport && item.type === 'Reasoning') {
    return yield* codexResponseItem(
      {
        type: 'reasoning',
        text:
          (yield* codexSummaryText(item.summary_text)) ??
          (yield* codexSummaryText(item.raw_content))
      },
      id,
      timestamp
    )
  }
  if (item.type === 'ContextCompaction') {
    return codexCompactionMarker(id, timestamp)
  }
  const blocks = yield* codexTurnItemBlocks(item.content)
  if (blocks.length === 0) {
    return null
  }
  if (item.type === 'UserMessage' || item.type === 'user_message') {
    return { id, role: 'user', blocks, timestamp, source: 'transcript' }
  }
  if (item.type === 'AgentMessage' || item.type === 'agent_message') {
    return { id, role: 'assistant', blocks, timestamp, source: 'transcript' }
  }
  return null
}

function codexCompactionMarker(id: string, timestamp: number | null): NativeChatMessage {
  return {
    id,
    role: 'system',
    blocks: [
      { type: 'text', text: NATIVE_CHAT_NOTICE_COPY.compaction, presentation: 'compaction' }
    ],
    timestamp,
    source: 'transcript'
  }
}

/** Preserve raw argument shape for all consumers; callers needing structure decode it themselves. */
function codexCallInput(payload: Record<string, unknown>): unknown {
  if (payload.arguments !== undefined) {
    return payload.arguments
  }
  return payload.input ?? payload.action ?? null
}

function parseTimestamp(value: unknown): number | null {
  const parsed = timestampMs(value)
  return Number.isFinite(parsed) ? parsed : null
}
