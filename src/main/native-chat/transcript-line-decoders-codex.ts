// Codex JSONL line → NativeChatMessage decoder.

import type { NativeChatBlock, NativeChatMessage } from '../../shared/native-chat-types'
import {
  asRecord,
  extractString,
  parseJsonObject,
  timestampMs
} from '../ai-vault/session-scanner-values'
import { claudeContentBlocks, toolResultOutput } from './transcript-record-blocks'

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
    return null
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
