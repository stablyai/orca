// omp (pi-agent) JSONL line → NativeChatMessage decoder.
//
// Conversation turns are `type: 'message'`; every other record type is session
// bookkeeping. Turn order is file order, so `parentId` is not consulted here.

import type { NativeChatMessage } from '../../shared/native-chat-types'
import {
  asRecord,
  extractString,
  parseJsonObject,
  timestampMs
} from '../ai-vault/session-scanner-values'
import { ompContentBlocks, toolResultOutput } from './transcript-record-blocks'

/**
 * omp session rows: `type: 'message'` turns carrying user/assistant/toolResult/
 * developer records with text, thinking, toolCall and image content blocks.
 * Session bookkeeping rows (session_init, mode_change, compaction, custom) are
 * skipped, as are records of an unrecognized type.
 */
export function decodeOmpTranscriptLine(
  line: string,
  fallbackId: string
): NativeChatMessage | null {
  const record = parseJsonObject(line)
  if (!record || record.type !== 'message') {
    return null
  }
  const message = asRecord(record.message)
  if (!message) {
    return null
  }
  const id = extractString(record.id) ?? fallbackId
  const timestamp = parseTimestamp(record.timestamp)
  const role = extractString(message.role)

  if (role === 'toolResult') {
    return {
      id,
      role: 'tool',
      blocks: [
        {
          type: 'tool-result',
          output: toolResultOutput(message.content),
          ...(message.isError === true ? { isError: true } : {})
        }
      ],
      timestamp,
      source: 'transcript'
    }
  }

  const blocks = ompContentBlocks(message.content)
  if (blocks.length === 0) {
    return null
  }
  const messageRole = role === 'assistant' ? 'assistant' : role === 'user' ? 'user' : 'system'
  return { id, role: messageRole, blocks, timestamp, source: 'transcript' }
}

/** `timestampMs` yields NaN for an unparsable value; the chat model wants null. */
function parseTimestamp(value: unknown): number | null {
  const parsed = timestampMs(value)
  return Number.isFinite(parsed) ? parsed : null
}
