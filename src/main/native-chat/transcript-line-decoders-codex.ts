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
  if (payload.type === 'function_call') {
    const name = extractString(payload.name) ?? 'tool'
    const callId = extractString(payload.call_id)
    return {
      id,
      role: 'assistant',
      blocks: [
        {
          type: 'tool-call',
          name,
          input: codexCallInput(payload),
          ...(callId ? { callId } : {})
        }
      ],
      timestamp,
      source: 'transcript'
    }
  }
  if (payload.type === 'local_shell_call') {
    const callId = extractString(payload.call_id)
    const status = codexCallStatus(payload.status)
    return {
      id,
      role: 'assistant',
      blocks: [
        {
          type: 'tool-call',
          name: extractString(payload.name) ?? 'shell',
          input: payload.action ?? null,
          ...(callId ? { callId } : {}),
          ...(status ? { status } : {})
        }
      ],
      timestamp,
      source: 'transcript'
    }
  }
  if (payload.type === 'custom_tool_call') {
    const name = extractString(payload.name) ?? 'tool'
    const callId = extractString(payload.call_id)
    const status = codexCallStatus(payload.status)
    return {
      id,
      role: 'assistant',
      blocks: [
        {
          type: 'tool-call',
          name,
          // Why: custom tools such as Codex apply_patch use freeform input;
          // parsing it as function arguments would destroy the patch envelope.
          input: payload.input ?? '',
          ...(callId ? { callId } : {}),
          ...(status ? { status } : {})
        }
      ],
      timestamp,
      source: 'transcript'
    }
  }
  if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
    return {
      id,
      role: 'tool',
      blocks: [codexToolResult(payload.output, extractString(payload.call_id))],
      timestamp,
      source: 'transcript'
    }
  }
  if (payload.type === 'tool_search_call' || payload.type === 'tool_search_output') {
    // Why: tool-search records describe provider-side tool discovery, not an
    // executed operation with user-auditable command or filesystem output.
    return null
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
    return parseCodexFunctionArguments(payload.arguments)
  }
  return payload.input ?? payload.action ?? null
}

function codexToolResult(output: unknown, callId: string | null): NativeChatBlock {
  const record = asRecord(output)
  const text = toolResultOutput(record?.content ?? record?.output ?? output)
  const outcome = codexToolResultOutcome(record, text)
  return {
    type: 'tool-result',
    output: text,
    ...(outcome === 'error' ? { isError: true } : {}),
    ...(callId ? { callId } : {}),
    outcome
  }
}

function parseCodexFunctionArguments(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value
  }
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function codexCallStatus(value: unknown): 'in-progress' | 'completed' | 'incomplete' | null {
  if (value === 'in_progress') {
    return 'in-progress'
  }
  return value === 'completed' || value === 'incomplete' ? value : null
}

function codexToolResultOutcome(
  record: Record<string, unknown> | null,
  output: string
): 'success' | 'error' | 'unknown' {
  if (record?.success === false || record?.is_error === true) {
    return 'error'
  }
  if (record?.success === true) {
    return 'success'
  }
  const normalized = output.replace(/\r\n/g, '\n')
  // Why: these are the success/error envelopes emitted by Codex's native
  // apply_patch handler; arbitrary function output remains explicitly unknown.
  if (
    normalized.startsWith('Success.\nUpdated the following files:') ||
    normalized.startsWith('Success. Updated the following files:')
  ) {
    return 'success'
  }
  if (normalized.startsWith('apply_patch verification failed:')) {
    return 'error'
  }
  return 'unknown'
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
