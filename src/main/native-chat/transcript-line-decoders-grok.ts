// Grok chat_history.jsonl line → NativeChatMessage decoder.

import type { NativeChatBlock, NativeChatMessage } from '../../shared/native-chat-types'
import {
  asRecord,
  extractString,
  parseJsonObject,
  timestampMs
} from '../ai-vault/session-scanner-values'
import { claudeContentBlocks, toolResultOutput } from './transcript-record-blocks'

/**
 * Grok `chat_history.jsonl` rows: user/assistant/reasoning/tool records with
 * Claude-like content blocks plus Grok-specific `backend_tool_call` /
 * `tool_result` shapes. System prompts are skipped.
 */
export function decodeGrokTranscriptLine(
  line: string,
  fallbackId: string
): NativeChatMessage | null {
  const record = parseJsonObject(line)
  if (!record) {
    return null
  }
  const type = extractString(record.type)
  if (!type) {
    return null
  }
  const timestamp = parseTimestamp(record.timestamp)
  const id = extractString(record.id) ?? fallbackId

  if (type === 'user' || type === 'assistant') {
    const blocks = claudeContentBlocks(record.content)
    const stripped = blocks
      .map(stripGrokUserQueryBlock)
      .filter((block): block is NativeChatBlock => block !== null)
    if (stripped.length === 0) {
      // Empty assistant rows often only hold tool_calls — surface those.
      const toolBlocks = grokToolCallBlocks(record.tool_calls)
      if (toolBlocks.length === 0) {
        return null
      }
      return { id, role: 'assistant', blocks: toolBlocks, timestamp, source: 'transcript' }
    }
    if (type === 'assistant') {
      const toolBlocks = grokToolCallBlocks(record.tool_calls)
      return {
        id,
        role: 'assistant',
        blocks: [...stripped, ...toolBlocks],
        timestamp,
        source: 'transcript'
      }
    }
    return { id, role: 'user', blocks: stripped, timestamp, source: 'transcript' }
  }

  if (type === 'reasoning') {
    const text =
      extractString(record.text) ??
      grokSummaryText(record.summary) ??
      extractString(asRecord(record.content)?.text)
    if (!text?.trim()) {
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

  if (type === 'backend_tool_call' || type === 'tool_call') {
    const name =
      extractString(asRecord(record.kind)?.tool_type) ??
      extractString(record.name) ??
      extractString(record.tool) ??
      'tool'
    return {
      id,
      role: 'assistant',
      blocks: [{ type: 'tool-call', name, input: record.kind ?? record.arguments ?? record.input }],
      timestamp,
      source: 'transcript'
    }
  }

  if (type === 'tool_result') {
    const output = toolResultOutput(record.content ?? record.output ?? record.result)
    return {
      id,
      role: 'tool',
      blocks: [
        {
          type: 'tool-result',
          output,
          ...(record.is_error === true || record.isError === true ? { isError: true } : {})
        }
      ],
      timestamp,
      source: 'transcript'
    }
  }

  return null
}

function grokToolCallBlocks(value: unknown): NativeChatBlock[] {
  if (!Array.isArray(value)) {
    return []
  }
  const blocks: NativeChatBlock[] = []
  for (const item of value) {
    const record = asRecord(item)
    if (!record) {
      continue
    }
    const name = extractString(record.name) ?? extractString(record.tool) ?? 'tool'
    let input: unknown = record.arguments ?? record.input ?? record.args
    if (typeof input === 'string') {
      try {
        input = JSON.parse(input)
      } catch {
        // keep string
      }
    }
    blocks.push({ type: 'tool-call', name, input })
  }
  return blocks
}

function grokSummaryText(value: unknown): string | null {
  if (typeof value === 'string') {
    return value
  }
  if (!Array.isArray(value)) {
    return null
  }
  const parts: string[] = []
  for (const item of value) {
    const record = asRecord(item)
    const text = extractString(record?.text) ?? extractString(record?.summary_text)
    if (text) {
      parts.push(text)
    }
  }
  return parts.length > 0 ? parts.join('\n') : null
}

function stripGrokUserQueryBlock(block: NativeChatBlock): NativeChatBlock | null {
  if (block.type !== 'text') {
    return block
  }
  const stripped = stripGrokUserQueryEnvelope(block.text)
  if (!stripped.trim()) {
    return null
  }
  return stripped === block.text ? block : { type: 'text', text: stripped }
}

function stripGrokUserQueryEnvelope(text: string): string {
  const opener = '<user_query>'
  const closer = '</user_query>'
  const lower = text.toLowerCase()
  const start = lower.indexOf(opener)
  if (start === -1) {
    return text
  }
  const bodyStart = start + opener.length
  const end = lower.indexOf(closer, bodyStart)
  if (end === -1) {
    return text.slice(bodyStart).trim()
  }
  return text.slice(bodyStart, end).trim()
}

function parseTimestamp(value: unknown): number | null {
  const parsed = timestampMs(value)
  return Number.isFinite(parsed) ? parsed : null
}
