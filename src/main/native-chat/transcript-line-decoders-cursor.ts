// Cursor agent-transcripts JSONL line → NativeChatMessage decoder.

import type { NativeChatBlock, NativeChatMessage } from '../../shared/native-chat-types'
import {
  asRecord,
  extractString,
  parseJsonObject,
  timestampMs
} from '../ai-vault/session-scanner-values'
import { claudeContentBlocks } from './transcript-record-blocks'

/**
 * Cursor `agent-transcripts/*.jsonl` rows: `{ role, message.content, timestamp }`.
 * Content is Claude-shaped (text / tool_use). User turns wrap the typed prompt in
 * `<timestamp>` and `<user_query>` envelopes that do not belong in the bubble.
 */
export function decodeCursorTranscriptLine(
  line: string,
  fallbackId: string
): NativeChatMessage | null {
  const record = parseJsonObject(line)
  if (!record) {
    return null
  }
  const role = extractString(record.role)
  if (role !== 'user' && role !== 'assistant') {
    return null
  }
  const message = asRecord(record.message)
  const rawBlocks = claudeContentBlocks(message?.content ?? record.content)
  const blocks = role === 'user' ? rawBlocks.flatMap(normalizeCursorUserBlock) : rawBlocks
  if (blocks.length === 0) {
    return null
  }
  return {
    id: extractString(record.id) ?? extractString(record.uuid) ?? fallbackId,
    role,
    blocks,
    timestamp: parseTimestamp(record.timestamp),
    source: 'transcript'
  }
}

function normalizeCursorUserBlock(block: NativeChatBlock): NativeChatBlock[] {
  if (block.type !== 'text') {
    return [block]
  }
  const stripped = stripCursorUserEnvelope(block.text)
  if (!stripped.trim()) {
    return []
  }
  return stripped === block.text ? [block] : [{ type: 'text', text: stripped }]
}

function stripCursorUserEnvelope(text: string): string {
  return unwrapTaggedEnvelope(removeTaggedEnvelope(text, 'timestamp'), 'user_query')
}

function removeTaggedEnvelope(text: string, tag: string): string {
  const bounds = taggedEnvelopeBounds(text, tag)
  if (!bounds) {
    return text
  }
  return `${text.slice(0, bounds.start)}${text.slice(bounds.end)}`.trim()
}

function unwrapTaggedEnvelope(text: string, tag: string): string {
  const bounds = taggedEnvelopeBounds(text, tag)
  if (!bounds) {
    return text.trim()
  }
  return text.slice(bounds.innerStart, bounds.innerEnd).trim()
}

function taggedEnvelopeBounds(
  text: string,
  tag: string
): { start: number; innerStart: number; innerEnd: number; end: number } | null {
  const opener = `<${tag}>`
  const closer = `</${tag}>`
  const lower = text.toLowerCase()
  const start = lower.indexOf(opener)
  if (start === -1) {
    return null
  }
  const innerStart = start + opener.length
  const innerEnd = lower.indexOf(closer, innerStart)
  if (innerEnd === -1) {
    return { start, innerStart, innerEnd: text.length, end: text.length }
  }
  return { start, innerStart, innerEnd, end: innerEnd + closer.length }
}

function parseTimestamp(value: unknown): number | null {
  const parsed = timestampMs(value)
  return Number.isFinite(parsed) ? parsed : null
}
