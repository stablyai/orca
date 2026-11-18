import { serialize } from 'node:v8'
import { describeWorkerMessage } from '../../worker-threads/worker-message-shape'
import { journalSqlFailure } from './journal-sql-failure'
import type { JournalSqlReaderReply } from './journal-sql-reader-protocol'

/**
 * Main deserializes every reader reply into the ~3.25 GB V8 heap it shares with all workers; a
 * decoded whole-chat read (647 MB of JSON, ~931 MB retained) exhausted it and aborted Orca.
 * Decoding costs 1.0-1.9x the serialized bytes (journal rows, records), so this keeps one reply
 * under ~120 MB of main heap, far above any paged read.
 */
export const JOURNAL_READER_REPLY_BYTE_LIMIT = 64 * 2 ** 20

/**
 * The bounded walk sizes a reply it saw whole; one it cut short is measured, so rows past the walk
 * can't hide. One stored item is refused like any aggregate: a completed tool output is kept whole,
 * so a single item can be hundreds of MB. The record set loads the chat store itself: refusing it
 * would leave every chat unopenable, and it grows only with chat count (~25 MB at 18k chats).
 */
export function journalReaderReplyExceedsLimit(
  reply: unknown,
  limit = JOURNAL_READER_REPLY_BYTE_LIMIT
): boolean {
  if (isRecordSetReply(reply)) {
    return false
  }
  const shape = describeWorkerMessage(reply)
  return (shape.truncated || shape.bytes > limit / 4) && serialize(reply).byteLength > limit
}

/** The reader posts every reply through this: an oversized one becomes its request's failure. */
export function limitJournalReaderReply<T extends { type: string }>(
  reply: T,
  limit = JOURNAL_READER_REPLY_BYTE_LIMIT
): T | Extract<JournalSqlReaderReply, { type: 'failed' }> {
  if (
    reply.type === 'failed' ||
    !('id' in reply) ||
    typeof reply.id !== 'number' ||
    !journalReaderReplyExceedsLimit(reply, limit)
  ) {
    return reply
  }
  return {
    type: 'failed',
    id: reply.id,
    error: journalSqlFailure(
      new Error(`${REPLY_LIMIT_FAILURE} (${reply.type}) exceeds ${limit} bytes`)
    )
  }
}

const REPLY_LIMIT_FAILURE = 'journal read reply'

/** A chat whose rows can't fit one reply fails the same way at every retry. */
export function isJournalReaderReplyLimitFailure(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith(`${REPLY_LIMIT_FAILURE} (`)
}

function isRecordSetReply(reply: unknown): boolean {
  if (typeof reply !== 'object' || reply === null || !('type' in reply) || !('result' in reply)) {
    return false
  }
  const { result } = reply
  return (
    reply.type === 'database' &&
    typeof result === 'object' &&
    result !== null &&
    'kind' in result &&
    result.kind === 'records'
  )
}
