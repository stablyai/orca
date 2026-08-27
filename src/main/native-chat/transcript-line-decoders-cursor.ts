import type { NativeChatMessage } from '../../shared/native-chat-types'
import { asRecord, extractString, parseJsonObject } from '../ai-vault/session-scanner-values'
import { claudeContentBlocks } from './transcript-record-blocks'

/** Cursor Agent message rows carry Claude-shaped content blocks without ids or timestamps. */
export function decodeCursorTranscriptLine(
  line: string,
  fallbackId: string
): NativeChatMessage | null {
  const record = parseJsonObject(line)
  const role = extractString(record?.role)
  if (role !== 'user' && role !== 'assistant') {
    return null
  }
  const blocks = claudeContentBlocks(asRecord(record?.message)?.content)
  return blocks.length > 0
    ? { id: fallbackId, role, blocks, timestamp: null, source: 'transcript' }
    : null
}
