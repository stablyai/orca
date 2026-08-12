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
import { CODEX_EVENT_TURN_ABORTED } from './transcript-turn-markers'

export function decodeCodexTranscriptLine(
  line: string,
  fallbackId: string
): NativeChatMessage | null {
  const record = parseJsonObject(line)
  if (!record) {
    return null
  }
  const payload = asRecord(record.payload)
  if (!payload) {
    const id = extractString(record.id) ?? fallbackId
    return codexUnwrappedResponseItem(record, id, parseTimestamp(record.timestamp))
  }
  const timestamp = parseTimestamp(record.timestamp)
  const baseId = extractString(payload.id) ?? fallbackId

  if (record.type === 'response_item') {
    return codexResponseItem(payload, baseId, timestamp)
  }
  if (record.type === 'event_msg') {
    return codexEventMessage(payload, baseId, timestamp)
  }
  return null
}

function codexUnwrappedResponseItem(
  record: Record<string, unknown>,
  id: string,
  timestamp: number | null
): NativeChatMessage | null {
  if (record.type !== 'message') {
    return codexResponseItem(record, id, timestamp)
  }
  const role = record.role === 'assistant' ? 'assistant' : record.role === 'user' ? 'user' : null
  const blocks = codexTurnItemBlocks(record.content)
  return role && blocks.length > 0 ? { id, role, blocks, timestamp, source: 'transcript' } : null
}

function codexResponseItem(
  payload: Record<string, unknown>,
  id: string,
  timestamp: number | null
): NativeChatMessage | null {
  if (payload.type === 'message') {
    const role =
      payload.role === 'assistant' ? 'assistant' : payload.role === 'user' ? 'user' : null
    if (!role) {
      return null
    }
    const blocks = claudeContentBlocks(payload.content)
    if (blocks.length === 0) {
      return null
    }
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
  if (
    payload.type === 'function_call' ||
    payload.type === 'local_shell_call' ||
    payload.type === 'custom_tool_call'
  ) {
    const name = extractString(payload.name) ?? 'tool'
    return {
      id,
      role: 'assistant',
      blocks: [{ type: 'tool-call', name, input: codexCallInput(payload) }],
      timestamp,
      source: 'transcript'
    }
  }
  if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
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
  if (payload.type === 'item_completed') {
    return codexCompletedTurnItem(payload, id, timestamp)
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

function codexCompletedTurnItem(
  payload: Record<string, unknown>,
  fallbackId: string,
  timestamp: number | null
): NativeChatMessage | null {
  const item = asRecord(payload.item)
  if (!item) {
    return null
  }
  const id = extractString(item.id) ?? fallbackId
  const blocks = codexTurnItemBlocks(item.content)
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

function codexTurnItemBlocks(content: unknown): NativeChatBlock[] {
  if (!Array.isArray(content)) {
    return []
  }
  const blocks: NativeChatBlock[] = []
  for (const value of content) {
    const item = asRecord(value)
    if (!item) {
      continue
    }
    if (
      item.type === 'text' ||
      item.type === 'Text' ||
      item.type === 'input_text' ||
      item.type === 'output_text'
    ) {
      const text = extractString(item.text)
      if (text) {
        blocks.push({ type: 'text', text })
      }
      continue
    }
    if (item.type === 'image' || item.type === 'Image' || item.type === 'input_image') {
      const url = extractString(item.image_url) ?? extractString(item.url)
      if (url) {
        blocks.push({ type: 'image-ref', url })
      }
      continue
    }
    if (item.type === 'local_image' || item.type === 'LocalImage') {
      const path = extractString(item.path)
      if (path) {
        blocks.push({ type: 'image-ref', path })
      }
    }
  }
  return blocks
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
