// Muse Code session.jsonl line → NativeChatMessage decoder.
//
// Layout: <root>/YYYY/MM/DD/<uuid>/session.jsonl. Conversation turns are a few
// record shapes amid heavy bookkeeping (task lifecycle, reasoning, usage,
// reminders): `runtime.user_intent.accepted` (user), `assistant_message_committed`
// (assistant text), `assistant_tool_calls_committed` / `tool_result_batch_committed`
// (tool turns), `user_input_prompt_requested/settled` (question cards), and a
// cancelled `terminal` (interrupt row). Everything else skips, including the
// `retained_frame` / `retained_marker` retention envelopes, which carry no
// conversation payload.

import {
  NATIVE_CHAT_INTERRUPTED_STATUS_TEXT,
  type NativeChatBlock,
  type NativeChatMessage
} from '../../shared/native-chat-types'
import { museTimestampMs } from '../ai-vault/session-scanner-muse-parser'
import {
  arrayValue,
  asRecord,
  extractString,
  parseJsonObject
} from '../ai-vault/session-scanner-values'
import { toolResultOutput } from './transcript-record-blocks'

/**
 * Muse session rows: `runtime.user_intent.accepted` user turns plus the run
 * events the assistant emits (message, tool calls, tool results, question
 * prompts and their answers, terminal interrupts). Records of any other shape
 * are engine bookkeeping and return null.
 */
export function decodeMuseTranscriptLine(
  line: string,
  fallbackId: string
): NativeChatMessage | null {
  const record = parseJsonObject(line)
  if (!record) {
    return null
  }
  const id = extractString(record.id) ?? fallbackId
  const timestamp = museTimestampMs(record.recorded_at)
  const payload = asRecord(record.payload)
  if (!payload) {
    return null
  }

  if (extractString(record.payload_type) === 'runtime.user_intent.accepted') {
    const text = museUserText(payload)
    return text
      ? { id, role: 'user', blocks: [{ type: 'text', text }], timestamp, source: 'transcript' }
      : null
  }

  const event = asRecord(payload.event)
  if (!event) {
    return null
  }
  const kind = extractString(event.kind)
  if (!kind) {
    return null
  }
  switch (kind) {
    case 'assistant_message_committed': {
      const text = extractString(event.text)
      return text
        ? {
            id,
            role: 'assistant',
            blocks: [{ type: 'text', text }],
            timestamp,
            source: 'transcript'
          }
        : null
    }
    case 'assistant_tool_calls_committed': {
      const blocks = museToolCallBlocks(event.tool_calls)
      return blocks.length === 0
        ? null
        : { id, role: 'assistant', blocks, timestamp, source: 'transcript' }
    }
    case 'tool_result_batch_committed': {
      const blocks = museToolResultBlocks(event.results)
      return blocks.length === 0
        ? null
        : { id, role: 'tool', blocks, timestamp, source: 'transcript' }
    }
    case 'user_input_prompt_requested': {
      const text = museQuestionText(event.questions)
      return text
        ? {
            id,
            role: 'assistant',
            blocks: [{ type: 'text', text }],
            timestamp,
            source: 'transcript'
          }
        : null
    }
    case 'user_input_prompt_settled': {
      const text = museAnswerText(event.answers)
      return text
        ? { id, role: 'user', blocks: [{ type: 'text', text }], timestamp, source: 'transcript' }
        : null
    }
    case 'terminal':
      // Why: a cancelled run stamps `terminal: 'cancelled'` on its own record
      // (a separate task `failed`/`cancelled` row carries only the reason, with
      // no tool link a stateless decoder could join). Surface the same
      // interrupted row the other decoders emit for their aborts.
      return event.terminal === 'cancelled'
        ? {
            id,
            role: 'system',
            blocks: [{ type: 'text', text: NATIVE_CHAT_INTERRUPTED_STATUS_TEXT }],
            timestamp,
            source: 'transcript'
          }
        : null
    default:
      return null
  }
}

/** All text blocks of a user intent: `refill_blocks`, then `model_messages` content. */
function museUserText(payload: Record<string, unknown>): string | null {
  const texts = textBlocks(payload.refill_blocks)
  if (texts.length === 0) {
    for (const message of arrayValue(payload.model_messages)) {
      texts.push(...textBlocks(asRecord(message)?.content))
    }
  }
  return texts.length === 0 ? null : texts.join('\n')
}

function textBlocks(value: unknown): string[] {
  const texts: string[] = []
  for (const block of arrayValue(value)) {
    const text = extractString(asRecord(block)?.text)
    if (text) {
      texts.push(text)
    }
  }
  return texts
}

function museToolCallBlocks(value: unknown): NativeChatBlock[] {
  const blocks: NativeChatBlock[] = []
  for (const item of arrayValue(value)) {
    const call = asRecord(item)
    if (!call) {
      continue
    }
    const callId = extractString(call.call_id)
    blocks.push({
      type: 'tool-call',
      name: extractString(call.name) ?? 'tool',
      input: parseToolArgs(call.args),
      ...(callId ? { callId } : {})
    })
  }
  return blocks
}

/** Muse writes tool args as a JSON string; keep the raw string when it won't parse. */
function parseToolArgs(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value ?? ''
  }
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed
  } catch {
    return value
  }
}

function museToolResultBlocks(value: unknown): NativeChatBlock[] {
  const blocks: NativeChatBlock[] = []
  for (const item of arrayValue(value)) {
    const result = asRecord(item)
    if (!result) {
      continue
    }
    // Why: read the output raw rather than via `extractString` — it trims, and
    // leading/trailing whitespace is meaningful in captured command output.
    // Muse results carry no error flag; the detached task `failed` row is skipped.
    blocks.push({ type: 'tool-result', output: toolResultOutput(result.text) })
  }
  return blocks
}

/** One assistant turn per question card: header, question, and option labels. */
function museQuestionText(value: unknown): string | null {
  const cards: string[] = []
  for (const item of arrayValue(value)) {
    const question = asRecord(item)
    if (!question) {
      continue
    }
    const header = extractString(question.header)
    const prompt = extractString(question.question)
    const options: string[] = []
    for (const option of arrayValue(question.options)) {
      const label = extractString(asRecord(option)?.label)
      if (label) {
        options.push(`- ${label}`)
      }
    }
    const head = [header, prompt].filter((part) => part).join(': ')
    const card = [head, ...options].filter((part) => part).join('\n')
    if (card) {
      cards.push(card)
    }
  }
  return cards.length === 0 ? null : cards.join('\n\n')
}

/** The user's answers render as their reply turn. */
function museAnswerText(value: unknown): string | null {
  const answers: string[] = []
  for (const item of arrayValue(value)) {
    const answer = asRecord(item)
    const label =
      extractString(answer?.selected_label) ??
      extractString(answer?.label) ??
      extractString(answer?.text)
    if (label) {
      answers.push(label)
    }
  }
  return answers.length === 0 ? null : answers.join('\n')
}
