// Codex JSONL line → NativeChatMessage decoder.

import {
  NATIVE_CHAT_INTERRUPTED_STATUS_TEXT,
  type NativeChatBlock,
  type NativeChatMessage
} from '../../shared/native-chat-types'
import {
  asRecord,
  extractString,
  parseJsonObject,
  timestampMs
} from '../ai-vault/session-scanner-values'
import { claudeContentBlocks, toolResultOutput } from './transcript-record-blocks'
import { codexTurnItem } from './transcript-codex-turn-items'
import { CODEX_EVENT_TURN_ABORTED } from './transcript-turn-markers'

export function decodeCodexTranscriptLine(
  line: string,
  fallbackId: string
): NativeChatMessage | null {
  return createCodexTranscriptLineDecoder()(line, fallbackId)
}

/** Keeps the rollout's history mode and adjacent cross-format duplicate state. */
export function createCodexTranscriptLineDecoder(): (
  line: string,
  fallbackId: string
) => NativeChatMessage | null {
  let historyMode: string | null = null
  let lastEmitted: { source: 'response-item' | 'turn-item'; fingerprint: string } | null = null

  return (line, fallbackId) => {
    const decoded = decodeCodexRecord(line, fallbackId, historyMode)
    if (decoded.historyMode !== undefined) {
      historyMode = decoded.historyMode
    }
    if (!decoded.message) {
      return null
    }
    if (!decoded.source) {
      return decoded.message
    }
    const fingerprint = messageFingerprint(decoded.message)
    if (
      lastEmitted &&
      lastEmitted.source !== decoded.source &&
      lastEmitted.fingerprint === fingerprint
    ) {
      return null
    }
    lastEmitted = { source: decoded.source, fingerprint }
    return decoded.message
  }
}

function decodeCodexRecord(
  line: string,
  fallbackId: string,
  historyMode: string | null
): {
  message: NativeChatMessage | null
  source?: 'response-item' | 'turn-item'
  historyMode?: string | null
} {
  const record = parseJsonObject(line)
  if (!record) {
    return { message: null }
  }
  const payload = asRecord(record.payload)
  if (!payload) {
    return { message: null }
  }
  if (record.type === 'session_meta') {
    return {
      message: null,
      historyMode: extractString(payload.history_mode) ?? extractString(payload.historyMode) ?? null
    }
  }
  const timestamp = parseTimestamp(record.timestamp)
  const baseId = extractString(payload.id) ?? fallbackId

  if (record.type === 'response_item') {
    // Why: paginated rollouts persist the same logical item in both formats;
    // TurnItems are canonical and carry stable ids, so rendering both duplicates turns.
    return {
      message: historyMode === 'paginated' ? null : codexResponseItem(payload, baseId, timestamp),
      source: 'response-item'
    }
  }
  if (record.type === 'event_msg') {
    return {
      message: codexEventMessage(payload, baseId, timestamp),
      source: payload.type === 'item_completed' ? 'turn-item' : undefined
    }
  }
  return { message: null }
}

function messageFingerprint(message: NativeChatMessage): string {
  return JSON.stringify([message.role, message.blocks])
}

function codexResponseItem(
  payload: Record<string, unknown>,
  id: string,
  timestamp: number | null
): NativeChatMessage | null {
  if (payload.type === 'message') {
    const blocks = claudeContentBlocks(payload.content)
    if (blocks.length === 0) {
      return null
    }
    const role =
      payload.role === 'assistant' ? 'assistant' : payload.role === 'user' ? 'user' : 'system'
    return { id, role, blocks, timestamp, source: 'transcript' }
  }
  if (payload.type === 'reasoning') {
    const text = extractString(payload.text) ?? codexSummaryText(payload.summary)
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
  if (payload.type === 'function_call' || payload.type === 'local_shell_call') {
    const name = extractString(payload.name) ?? 'tool'
    return {
      id,
      role: 'assistant',
      blocks: [{ type: 'tool-call', name, input: codexCallInput(payload) }],
      timestamp,
      source: 'transcript'
    }
  }
  if (payload.type === 'function_call_output') {
    return {
      id,
      role: 'tool',
      blocks: [codexToolResult(payload.output)],
      timestamp,
      source: 'transcript'
    }
  }
  return null
}

function codexEventMessage(
  payload: Record<string, unknown>,
  id: string,
  timestamp: number | null
): NativeChatMessage | null {
  if (payload.type === CODEX_EVENT_TURN_ABORTED) {
    return {
      id,
      role: 'system',
      blocks: [{ type: 'text', text: NATIVE_CHAT_INTERRUPTED_STATUS_TEXT }],
      timestamp,
      source: 'transcript'
    }
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
  // Why: paginated history emits completed TurnItems instead of the legacy
  // user_message/agent_message event variants.
  if (payload.type === 'item_completed') {
    const item = asRecord(payload.item)
    return item ? codexTurnItem(item, extractString(item.id) ?? id, timestamp) : null
  }
  return null
}

function codexCallInput(payload: Record<string, unknown>): unknown {
  if (payload.arguments !== undefined) {
    return payload.arguments
  }
  return payload.input ?? payload.action ?? null
}

function codexToolResult(output: unknown): NativeChatBlock {
  const record = asRecord(output)
  const isError = record?.success === false || record?.is_error === true
  return {
    type: 'tool-result',
    output: toolResultOutput(record?.content ?? record?.output ?? output),
    ...(isError ? { isError: true } : {})
  }
}

function codexSummaryText(summary: unknown): string | null {
  if (!Array.isArray(summary)) {
    return null
  }
  const parts: string[] = []
  for (const item of summary) {
    const text = extractString(asRecord(item)?.text) ?? extractString(item)
    if (text) {
      parts.push(text)
    }
  }
  return parts.length ? parts.join('\n') : null
}

function parseTimestamp(value: unknown): number | null {
  const parsed = timestampMs(value)
  return Number.isFinite(parsed) ? parsed : null
}
