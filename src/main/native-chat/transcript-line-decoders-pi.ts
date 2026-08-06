// Pi session JSONL line -> NativeChatMessage decoder.

import type { NativeChatBlock, NativeChatMessage } from '../../shared/native-chat-types'
import {
  asRecord,
  extractString,
  parseJsonObject,
  timestampMs
} from '../ai-vault/session-scanner-values'
import { toolResultOutput } from './transcript-record-blocks'

type PiMessageRole = 'user' | 'assistant' | 'toolResult'

export function decodePiTranscriptLine(line: string, fallbackId: string): NativeChatMessage | null {
  const record = parseJsonObject(line)
  if (record?.type !== 'message') {
    return null
  }
  const message = asRecord(record.message)
  const role = extractString(message?.role) as PiMessageRole | null
  if (!message || !isPiMessageRole(role)) {
    return null
  }
  const blocks = piMessageBlocks(message, role)
  if (blocks.length === 0) {
    return null
  }
  return {
    id: extractString(record.id) ?? fallbackId,
    role: role === 'toolResult' ? 'tool' : role,
    blocks,
    timestamp: parseTimestamp(record.timestamp ?? message.timestamp),
    source: 'transcript'
  }
}

function isPiMessageRole(value: string | null): value is PiMessageRole {
  return value === 'user' || value === 'assistant' || value === 'toolResult'
}

function piMessageBlocks(message: Record<string, unknown>, role: PiMessageRole): NativeChatBlock[] {
  if (role === 'toolResult') {
    return [
      {
        type: 'tool-result',
        output: toolResultOutput(message.content),
        ...(message.isError === true ? { isError: true } : {})
      }
    ]
  }
  const content = typeof message.content === 'string' ? [message.content] : message.content
  if (!Array.isArray(content)) {
    return []
  }
  const blocks: NativeChatBlock[] = []
  for (const item of content) {
    if (typeof item === 'string') {
      if (item.trim()) {
        blocks.push({ type: 'text', text: item })
      }
      continue
    }
    const block = asRecord(item)
    if (!block) {
      continue
    }
    if (block.type === 'text' || block.type === 'thinking') {
      const text = extractString(block.text) ?? extractString(block.thinking)
      if (text) {
        blocks.push({ type: 'text', text })
      }
      continue
    }
    if (block.type === 'toolCall') {
      blocks.push({
        type: 'tool-call',
        name: extractString(block.name) ?? 'tool',
        input: block.arguments ?? {}
      })
    }
  }
  return blocks
}

function parseTimestamp(value: unknown): number | null {
  const parsed = timestampMs(value)
  return Number.isFinite(parsed) ? parsed : null
}
