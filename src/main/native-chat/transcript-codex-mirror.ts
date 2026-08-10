import type { NativeChatMessage } from '../../shared/native-chat-types'
import { asRecord, extractString, parseJsonObject } from '../ai-vault/session-scanner-values'
import { isCodexTranscriptLineDecoder } from './transcript-line-decoders-codex'

export type CodexTextMirrorRecord = {
  format: 'event' | 'response'
  role: 'user' | 'assistant'
  text: string
}

type TranscriptDecoder = (line: string, fallbackId: string) => NativeChatMessage | null

export function isCodexTranscriptDecoder(decode: TranscriptDecoder): boolean {
  return isCodexTranscriptLineDecoder(decode)
}

export function codexTextMirrorRecord(line: string): CodexTextMirrorRecord | null {
  const record = parseJsonObject(line)
  const payload = asRecord(record?.payload)
  if (!record || !payload) {
    return null
  }
  if (record.type === 'event_msg') {
    const role = payload.type === 'user_message' ? 'user' : 'assistant'
    if (payload.type !== 'user_message' && payload.type !== 'agent_message') {
      return null
    }
    const text = extractString(payload.message)
    return text ? { format: 'event', role, text } : null
  }
  if (record.type !== 'response_item' || payload.type !== 'message') {
    return null
  }
  const role = payload.role === 'user' ? 'user' : payload.role === 'assistant' ? 'assistant' : null
  if (!role || !Array.isArray(payload.content)) {
    return null
  }
  const expectedType = role === 'user' ? 'input_text' : 'output_text'
  let text: string | null = null
  for (const item of payload.content) {
    const block = asRecord(item)
    if (block?.type !== expectedType && block?.type !== 'text') {
      continue
    }
    const candidate = extractString(block.text)
    if (!candidate) {
      continue
    }
    if (text !== null) {
      return null
    }
    text = candidate
  }
  return text ? { format: 'response', role, text } : null
}

export function areCodexTextMirrors(
  first: CodexTextMirrorRecord | null,
  second: CodexTextMirrorRecord | null
): boolean {
  return (
    first !== null &&
    second !== null &&
    first.format !== second.format &&
    first.role === second.role &&
    first.text === second.text
  )
}

export function consumeCodexTextMirror(
  previous: CodexTextMirrorRecord | null,
  line: string
): { duplicate: boolean; current: CodexTextMirrorRecord | null } {
  const current = codexTextMirrorRecord(line)
  const duplicate = areCodexTextMirrors(previous, current)
  // A matched pair consumes both records. Clearing the cursor prevents a third,
  // deliberately repeated record from being folded into the same pair.
  return { duplicate, current: duplicate ? null : current }
}
