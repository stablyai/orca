import type {
  NativeChatBlock,
  NativeChatMessage,
  NativeChatRole
} from '../../shared/native-chat-types'
import {
  asRecord,
  extractString,
  parseJsonObject,
  timestampMs
} from '../ai-vault/session-scanner-values'

const ROLES = new Set<NativeChatRole>(['user', 'assistant', 'tool', 'reasoning', 'system'])

/**
 * Decodes the JSONL message envelope emitted by Hermes session exports.
 * Unknown records and future event types are deliberately ignored: the
 * session store is the source of truth, while operational events are not
 * conversation messages and should not become fabricated transcript rows.
 */
export function decodeHermesTranscriptLine(
  line: string,
  fallbackId: string
): NativeChatMessage | null {
  const record = parseJsonObject(line)
  if (!record) { return null }

  const message = asRecord(record.message) ?? record
  const role = normalizeRole(extractString(message.role))
  if (!role || !ROLES.has(role as NativeChatRole)) { return null }

  const blocks = decodeBlocks(message.content ?? message.parts ?? record.content)
  if (blocks.length === 0) { return null }

  return {
    id: extractString(record.id) ?? extractString(message.id) ?? fallbackId,
    role: role as NativeChatRole,
    blocks,
    timestamp: timestampMs(record.timestamp ?? message.timestamp),
    source: 'transcript'
  }
}

function normalizeRole(role: string | null): string | null {
  if (!role) { return null }
  if (role === 'model') { return 'assistant' }
  if (role === 'human') { return 'user' }
  return role
}

function stringifyToolOutput(value: unknown): string {
  if (typeof value === 'string') { return value }
  if (value == null) { return '' }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function decodeBlocks(value: unknown): NativeChatBlock[] {
  if (typeof value === 'string' && value.length > 0) {
    return [{ type: 'text', text: value }]
  }
  if (!Array.isArray(value)) { return [] }

  const blocks: NativeChatBlock[] = []
  for (const item of value) {
    if (typeof item === 'string' && item.length > 0) {
      blocks.push({ type: 'text', text: item })
      { continue }
    }
    const block = asRecord(item)
    if (!block) { continue }
    const type = extractString(block.type)
    if (type === 'text' && typeof block.text === 'string') {
      blocks.push({ type: 'text', text: block.text })
    } else if (type === 'thinking' && typeof block.thinking === 'string') {
      blocks.push({ type: 'text', text: block.thinking })
    } else if (type === 'tool-call') {
      const name = extractString(block.name) ?? 'tool'
      blocks.push({ type: 'tool-call', name, input: block.input ?? {} })
    } else if (type === 'tool-result') {
      blocks.push({
        type: 'tool-result',
        output: stringifyToolOutput(block.output ?? block.content),
        ...(block.isError === true ? { isError: true } : {})
      })
    }
  }
  return blocks
}