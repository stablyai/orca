import { asRecord } from './session-scanner-record-value'
import { sliceAtCodeUnitLimit } from './session-scanner-text-normalization'
import type { AiVaultSessionPreviewMessage } from '../../shared/ai-vault-types'
import type { TranscriptMessage, TranscriptMessageRole } from './session-transcript-consumers'

// Safety bound only: a consumer applies its own caps. Matches the first-prompt
// copy path's ceiling so one pathological paste cannot dominate a scan.
const TRANSCRIPT_MESSAGE_TEXT_LIMIT = 256 * 1024
const TOOL_ARGUMENT_SCAN_LIMIT = 2000

const TEXT_BLOCK_TYPES = new Set(['text', 'input_text', 'output_text', 'thinking', 'reasoning'])
// The argument that identifies what a tool call actually did.
const TOOL_INPUT_KEYS = ['command', 'cmd', 'file_path', 'path', 'pattern', 'query', 'description']

type PreviewRole = AiVaultSessionPreviewMessage['role']

/** Only conversational roles reach consumers; system/unknown turns are noise. */
export function transcriptMessageRole(role: PreviewRole): TranscriptMessageRole | null {
  return role === 'user' || role === 'assistant' || role === 'tool' ? role : null
}

export function toolCallText(name: unknown, input: unknown): string | null {
  const toolName = typeof name === 'string' && name.trim() ? name.trim() : null
  const inputRecord = asRecord(input)
  let argument: string | null = null
  if (inputRecord) {
    for (const key of TOOL_INPUT_KEYS) {
      const value = inputRecord[key]
      if (typeof value === 'string' && value.trim()) {
        argument = value
        break
      }
    }
  } else if (typeof input === 'string' && input.trim()) {
    argument = input
  }
  if (!toolName && !argument) {
    return null
  }
  const bounded = argument ? sliceAtCodeUnitLimit(argument, TOOL_ARGUMENT_SCAN_LIMIT) : null
  return toolName && bounded ? `${toolName}: ${bounded}` : (toolName ?? bounded)
}

/** Flattens a tool_result body (a string, or an array of text blocks). */
function toolResultText(content: unknown): string | null {
  if (typeof content === 'string') {
    return content.trim() ? content : null
  }
  if (!Array.isArray(content)) {
    return null
  }
  const parts: string[] = []
  let length = 0
  for (const item of content) {
    const text = typeof item === 'string' ? item : asRecord(item)?.text
    if (typeof text === 'string' && text) {
      parts.push(text)
      length += text.length
      if (length >= TRANSCRIPT_MESSAGE_TEXT_LIMIT) {
        break
      }
    }
  }
  const joined = parts.join('\n')
  return joined.trim() ? joined : null
}

/**
 * Splits one provider content value into the messages it decodes to. Text
 * blocks keep the record's role; tool_use and tool_result blocks become `tool`
 * messages whichever record carried them (Claude stores tool results on user
 * records), so a consumer never has to know a provider's record shapes.
 */
export function transcriptMessagesFromContent(
  role: PreviewRole,
  content: unknown,
  timestamp: string | null
): TranscriptMessage[] {
  const messages: TranscriptMessage[] = []
  const textRole = transcriptMessageRole(role)
  if (typeof content === 'string') {
    const text = boundedText(content)
    return text && textRole ? [{ role: textRole, text, timestamp }] : []
  }
  const blocks = Array.isArray(content) ? content : content != null ? [content] : []
  const textParts: string[] = []
  for (const block of blocks) {
    if (typeof block === 'string') {
      textParts.push(block)
      continue
    }
    const item = asRecord(block)
    if (!item) {
      continue
    }
    const type = typeof item.type === 'string' ? item.type : null
    if (type === 'tool_use') {
      pushMessage(messages, 'tool', toolCallText(item.name, item.input), timestamp)
      continue
    }
    if (type === 'tool_result') {
      pushMessage(messages, 'tool', toolResultText(item.content), timestamp)
      continue
    }
    if (type !== null && !TEXT_BLOCK_TYPES.has(type)) {
      continue
    }
    const text = typeof item.text === 'string' ? item.text : item.content
    if (typeof text === 'string' && text) {
      textParts.push(text)
    }
  }
  if (textRole && textParts.length > 0) {
    // The record's own words lead; its tool blocks follow in transcript order.
    const text = boundedText(textParts.join('\n'))
    if (text) {
      messages.unshift({ role: textRole, text, timestamp })
    }
  }
  return messages
}

function pushMessage(
  messages: TranscriptMessage[],
  role: TranscriptMessageRole,
  text: string | null,
  timestamp: string | null
): void {
  const bounded = text === null ? null : boundedText(text)
  if (bounded) {
    messages.push({ role, text: bounded, timestamp })
  }
}

export function boundedText(value: string): string | null {
  const bounded = sliceAtCodeUnitLimit(value, TRANSCRIPT_MESSAGE_TEXT_LIMIT)
  return bounded.trim() ? bounded : null
}
