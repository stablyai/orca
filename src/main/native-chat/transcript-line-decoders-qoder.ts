import {
  NATIVE_CHAT_INTERRUPTED_STATUS_TEXT,
  type NativeChatMessage
} from '../../shared/native-chat-types'
import { asRecord, parseJsonObject } from '../ai-vault/session-scanner-values'
import { decodeClaudeTranscriptLine } from './transcript-line-decoders-claude'
import { qoderInterruptRowId } from './transcript-turn-markers'

/** Claude's format, except Qoder's readable thinking is reasoning and its bare interrupt notice is the interrupted status row. */
export function decodeQoderTranscriptLine(
  line: string,
  fallbackId: string
): NativeChatMessage | null {
  const message = decodeClaudeTranscriptLine(line, fallbackId)
  const record = message ? parseJsonObject(line) : null
  if (!message || !record) {
    return message
  }
  if (qoderInterruptRowId(record)) {
    return {
      ...message,
      role: 'system',
      blocks: [{ type: 'text', text: NATIVE_CHAT_INTERRUPTED_STATUS_TEXT }]
    }
  }
  return message.role === 'assistant' && isThinkingOnlyRecord(record)
    ? { ...message, role: 'reasoning' }
    : message
}

function isThinkingOnlyRecord(record: Record<string, unknown>): boolean {
  const content = asRecord(record.message)?.content
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every((block) => asRecord(block)?.type === 'thinking')
  )
}
