import type { DeliveryRow, MessageRow, QuestionRow, RunRow } from '../types'

export const SQLITE_UTC_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/

export function exposeUtcTimestamp(timestamp: string | null): string | null {
  if (!timestamp || !SQLITE_UTC_TIMESTAMP_RE.test(timestamp)) {
    return timestamp
  }
  return `${timestamp.replace(' ', 'T')}Z`
}

/** Epoch ms for a stored stamp in either the space format or an explicit-offset one.
 *  `null` = the column holds no value; `'unreadable'` = it holds one no parser accepts. The two
 *  stay distinct so a corrupt row can neither become a bogus instant nor be reported as "never
 *  written", and the literal (rather than `NaN`) keeps caller arithmetic type-checked and JSON-safe. */
export function readUtcTimestampMs(timestamp: string | null): number | null | 'unreadable' {
  const exposed = exposeUtcTimestamp(timestamp)
  // Only SQL NULL means "never written". An empty string is a value that was stored and lost its
  // contents, so it falls through to the parse and is classified as corruption.
  if (exposed === null) {
    return null
  }
  const parsed = Date.parse(exposed)
  return Number.isNaN(parsed) ? 'unreadable' : parsed
}

export function exposeMessageTimestamps(message: MessageRow): MessageRow {
  // Why: SQLite stores UTC as timezone-less space format for SQL ordering, but RPC/CLI consumers need an explicit offset.
  return {
    ...message,
    created_at: exposeUtcTimestamp(message.created_at) ?? message.created_at,
    delivered_at: exposeUtcTimestamp(message.delivered_at)
  }
}

export function exposeMessageListTimestamps(messages: MessageRow[]): MessageRow[] {
  return messages.map(exposeMessageTimestamps)
}

export function exposeRunTimestamps(run: RunRow): RunRow {
  return {
    ...run,
    created_at: exposeUtcTimestamp(run.created_at) ?? run.created_at,
    updated_at: exposeUtcTimestamp(run.updated_at) ?? run.updated_at
  }
}

export function exposeDeliveryTimestamps(delivery: DeliveryRow): DeliveryRow {
  return {
    ...delivery,
    created_at: exposeUtcTimestamp(delivery.created_at) ?? delivery.created_at,
    acknowledged_at: exposeUtcTimestamp(delivery.acknowledged_at)
  }
}

export function exposeQuestionTimestamps(question: QuestionRow): QuestionRow {
  return {
    ...question,
    created_at: exposeUtcTimestamp(question.created_at) ?? question.created_at,
    answered_at: exposeUtcTimestamp(question.answered_at),
    closed_at: exposeUtcTimestamp(question.closed_at)
  }
}
