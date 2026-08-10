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
): {
  duplicate: boolean
  candidate: CodexTextMirrorRecord | null
  current: CodexTextMirrorRecord | null
} {
  const candidate = codexTextMirrorRecord(line)
  const duplicate = areCodexTextMirrors(previous, candidate)
  // A matched pair consumes both records. Clearing the cursor prevents a third,
  // deliberately repeated record from being folded into the same pair.
  return { duplicate, candidate, current: duplicate ? null : candidate }
}

/**
 * Collapse a physical Codex mirror pair without making the result depend on
 * scan direction. The earlier JSONL record owns identity and ordering; blocks
 * found only on the later copy (most importantly user image attachments) are
 * folded into it.
 */
export function mergeCodexTextMirrorMessages(
  earlierRecord: CodexTextMirrorRecord | null,
  earlierMessage: NativeChatMessage | null,
  laterRecord: CodexTextMirrorRecord | null,
  laterMessage: NativeChatMessage | null
): NativeChatMessage | null {
  if (!areCodexTextMirrors(earlierRecord, laterRecord)) {
    return earlierMessage ?? laterMessage
  }
  const base = earlierMessage ?? laterMessage
  const supplement = base === earlierMessage ? laterMessage : earlierMessage
  if (!base || !supplement) {
    return base
  }
  const seen = new Set(base.blocks.map((block) => JSON.stringify(block)))
  const additional = supplement.blocks.filter((block) => {
    const key = JSON.stringify(block)
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
  return additional.length > 0 ? { ...base, blocks: [...base.blocks, ...additional] } : base
}
