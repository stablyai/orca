import {
  decodeSessionMessage,
  decodeToolCall,
  type DecodedSessionMessage,
  type DecodedToolCall
} from './session-decoded-message'
import { sliceAtCodeUnitLimit } from './session-scanner-text-normalization'
import type { AiVaultSessionPreviewMessage } from '../../shared/ai-vault-types'
import type { TranscriptMessage, TranscriptMessageRole } from './session-transcript-consumers'

// Bound pathological messages; consumers may impose tighter limits.
const TRANSCRIPT_MESSAGE_TEXT_LIMIT = 256 * 1024
const TOOL_ARGUMENT_SCAN_LIMIT = 2000

type PreviewRole = AiVaultSessionPreviewMessage['role']
type TranscriptText = { text: string | null; textTruncated: boolean }

export function transcriptMessageRole(role: PreviewRole): TranscriptMessageRole | null {
  return role === 'user' || role === 'assistant' || role === 'tool' ? role : null
}

export function toolCallContent(name: unknown, input: unknown): TranscriptText {
  return toolCallTextFromDecoded(decodeToolCall(name, input))
}

function toolCallTextFromDecoded(call: DecodedToolCall): TranscriptText {
  const { name, argument } = call
  const bounded = argument ? sliceAtCodeUnitLimit(argument, TOOL_ARGUMENT_SCAN_LIMIT) : null
  return {
    text: name && bounded ? `${name}: ${bounded}` : (name ?? bounded),
    textTruncated: argument !== null && bounded !== null && bounded.length < argument.length
  }
}

function toolResultText(textParts: Iterable<string>): TranscriptText {
  const parts: string[] = []
  let length = 0
  let omitted = false
  for (const text of textParts) {
    if (length >= TRANSCRIPT_MESSAGE_TEXT_LIMIT) {
      omitted = true
      break
    }
    parts.push(text)
    length += text.length
  }
  const joined = boundedJoinedText(parts)
  return { ...joined, textTruncated: omitted || joined.textTruncated }
}

export function transcriptMessagesFromContent(
  role: PreviewRole,
  content: unknown,
  timestamp: string | null
): TranscriptMessage[] {
  return transcriptMessagesFromDecodedMessage(decodeSessionMessage(role, content, timestamp))
}

export function transcriptMessagesFromDecodedMessage(
  decoded: DecodedSessionMessage
): TranscriptMessage[] {
  const messages: TranscriptMessage[] = []
  const textRole = transcriptMessageRole(decoded.role)
  const textParts: string[] = []
  for (const block of decoded.blocks) {
    if (block.kind === 'tool_call') {
      pushMessage(messages, 'tool', toolCallTextFromDecoded(block), decoded.timestamp)
    } else if (block.kind === 'tool_result') {
      pushMessage(messages, 'tool', toolResultText(block.textParts), decoded.timestamp)
    } else {
      textParts.push(block.text)
    }
  }
  if (textRole && textParts.length > 0) {
    const content = boundedJoinedText(textParts)
    const message = content.text
      ? transcriptMessageFromText(textRole, content.text, decoded.timestamp, content.textTruncated)
      : null
    if (message) {
      messages.unshift(message)
    }
  }
  return messages
}

function boundedJoinedText(parts: readonly string[]): TranscriptText {
  const length =
    parts.reduce((total, part) => total + part.length, 0) + Math.max(0, parts.length - 1)
  if (parts.length === 1) {
    const text = boundedText(parts[0])
    return { text, textTruncated: text !== null && text.length < length }
  }
  const prefixes: string[] = []
  // One extra code unit preserves truncation at a trailing high surrogate.
  let remaining = TRANSCRIPT_MESSAGE_TEXT_LIMIT + 1
  for (const part of parts) {
    if (prefixes.length > 0) {
      remaining--
    }
    const prefix = part.slice(0, remaining)
    prefixes.push(prefix)
    remaining -= prefix.length
    if (remaining === 0) {
      break
    }
  }
  const text = boundedText(prefixes.join('\n'))
  return { text, textTruncated: text !== null && text.length < length }
}

function pushMessage(
  messages: TranscriptMessage[],
  role: TranscriptMessageRole,
  content: TranscriptText,
  timestamp: string | null
): void {
  const message =
    content.text === null
      ? null
      : transcriptMessageFromText(role, content.text, timestamp, content.textTruncated)
  if (message) {
    messages.push(message)
  }
}

export function transcriptMessageFromText(
  role: TranscriptMessageRole,
  value: string,
  timestamp: string | null,
  textTruncated = false
): TranscriptMessage | null {
  const text = boundedText(value)
  return text
    ? {
        role,
        text,
        timestamp,
        ...(textTruncated || text.length < value.length ? { textTruncated: true as const } : {})
      }
    : null
}

export function boundedText(value: string): string | null {
  const bounded = sliceAtCodeUnitLimit(value, TRANSCRIPT_MESSAGE_TEXT_LIMIT)
  return bounded.trim() ? bounded : null
}
