// Shared detection of provider-authored turn boundaries. The message decoders
// render a visible status row from these lines; the lifecycle decoders settle
// the chat spinner from the same lines. Keeping the predicates here means the
// two consumers can never disagree about which JSONL line is an interrupt/abort
// or a turn boundary — updating a provider's format touches one place, so a
// rename can't leave a visible "interrupted" row that never settles (or vice
// versa).

import { asRecord, extractString } from '../ai-vault/session-scanner-values'

/**
 * The `interruptedMessageId` on a Claude user row when that row is Claude's
 * injected interrupt notice rather than a real user prompt. Returns undefined
 * for genuine user turns.
 */
export function claudeInterruptedMessageId(record: Record<string, unknown>): string | undefined {
  if (record.type !== 'user') {
    return undefined
  }
  return extractString(record.interruptedMessageId) ?? undefined
}

const QODER_INTERRUPT_NOTICE = /^\[Request interrupted by user( for tool use)?\]$/

/** The uuid of Qoder's interrupt notice: a bare user text row, without Claude's `interruptedMessageId`. */
export function qoderInterruptRowId(record: Record<string, unknown>): string | undefined {
  if (record.type !== 'user') {
    return undefined
  }
  const content = asRecord(record.message)?.content
  const blocks = Array.isArray(content) ? content : [content]
  const block = blocks.length === 1 ? blocks[0] : undefined
  const text = typeof block === 'string' ? block : extractString(asRecord(block)?.text)
  return text && QODER_INTERRUPT_NOTICE.test(text.trim())
    ? (extractString(record.uuid) ?? undefined)
    : undefined
}

/** Codex `event_msg` payload types that bound a turn's lifecycle. */
export const CODEX_EVENT_TURN_STARTED = 'task_started'
export const CODEX_EVENT_TURN_COMPLETE = 'task_complete'
export const CODEX_EVENT_TURN_ABORTED = 'turn_aborted'
