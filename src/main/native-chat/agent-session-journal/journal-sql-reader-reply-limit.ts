import { CLAUDE_IMPORT_PAGE_BYTES } from './history-import/journal-claude-import-worker-protocol'
import { ClaudeImportResourceError } from './history-import/journal-claude-import-resource-error'
import { serializedWorkerReplyBytes } from '../../utility-worker-host/utility-worker-reply-size'
import { serialize } from 'node:v8'
import { describeWorkerMessage } from '../../worker-threads/worker-message-shape'
import { journalSqlFailure } from './journal-sql-failure'
import type { JournalSqlReaderReply, JournalSqlReaderRequest } from './journal-sql-reader-protocol'

export function isClaudeRecoveryRelease(operation: JournalSqlReaderRequest['operation']): boolean {
  return (
    operation.kind === 'point' && operation.request.operation.kind === 'claude-recovery-release'
  )
}

export function journalReaderReplyLimit(operation: JournalSqlReaderRequest['operation']) {
  if (operation.kind !== 'point') {
    return undefined
  }
  const point = operation.request.operation
  const bounded =
    point.kind.startsWith('claude-recovery-') ||
    (point.kind === 'metadata' && !point.includeHistoryOrigin) ||
    (point.kind === 'history-items' && point.options?.maxReplyBytes === CLAUDE_IMPORT_PAGE_BYTES)
  return bounded ? CLAUDE_IMPORT_PAGE_BYTES : undefined
}

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
  return replyBytes(reply, limit).exceeds
}

/**
 * Never below the serialized size: the walk counts characters, and a two-byte string serializes
 * at twice that, so walked sizes count at UTF-16 width. Measured whenever the walk may miss rows.
 */
function replyBytes(reply: unknown, limit: number): { bytes?: number; exceeds: boolean } {
  if (isRecordSetReply(reply)) {
    return { exceeds: false }
  }
  const shape = describeWorkerMessage(reply)
  if (!shape.truncated && shape.bytes <= limit / 4) {
    return { bytes: shape.bytes * 2, exceeds: false }
  }
  const bytes = serialize(reply).byteLength
  return { bytes, exceeds: bytes > limit }
}

/** The reader posts every reply through this: an oversized one becomes its request's failure. */
export function limitJournalReaderReply<T extends { type: string }>(
  reply: T,
  limit = JOURNAL_READER_REPLY_BYTE_LIMIT
): T | Extract<JournalSqlReaderReply, { type: 'failed' }> {
  return measureJournalReaderReply(reply, limit).reply
}

/** `bytes` is absent for failures, untracked replies and the record set. */
export function measureJournalReaderReply<T extends { type: string }>(
  reply: T,
  limit = JOURNAL_READER_REPLY_BYTE_LIMIT
): { reply: T | Extract<JournalSqlReaderReply, { type: 'failed' }>; bytes?: number } {
  if (!('id' in reply) || typeof reply.id !== 'number') {
    return { reply }
  }
  if (reply.type === 'failed' && limit === JOURNAL_READER_REPLY_BYTE_LIMIT) {
    return { reply }
  }
  const { bytes, exceeds } =
    limit === CLAUDE_IMPORT_PAGE_BYTES ? framedReaderReplyBytes(reply) : replyBytes(reply, limit)
  if (!exceeds) {
    return bytes === undefined || reply.type === 'failed' ? { reply } : { reply, bytes }
  }
  return {
    reply: {
      type: 'failed',
      id: reply.id,
      error: journalSqlFailure(
        reply.type === 'point' && 'result' in reply && isClaudeRecoveryReply(reply.result)
          ? new ClaudeImportResourceError('A saved Claude history reply exceeds the page limit.')
          : new Error(`${REPLY_LIMIT_FAILURE} (${reply.type}) exceeds ${limit} bytes`)
      )
    }
  }
}

function isClaudeRecoveryReply(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    'kind' in result &&
    (result.kind === 'claude-recovery-slices' || result.kind === 'claude-recovery-fingerprints')
  )
}

function framedReaderReplyBytes(reply: { type: string }) {
  // Measure the largest credit-bearing form before taking credit.
  const { payload, framed } = serializedWorkerReplyBytes(
    reply.type === 'failed'
      ? reply
      : {
          ...reply,
          bytes: CLAUDE_IMPORT_PAGE_BYTES,
          creditWaitExpired: true
        }
  )
  return { bytes: payload, exceeds: framed > CLAUDE_IMPORT_PAGE_BYTES }
}

export function journalRecoveryPageEntriesBytes(result: unknown): number {
  const frame = serializedWorkerReplyBytes({
    type: 'point',
    id: Number.MAX_SAFE_INTEGER,
    result,
    bytes: CLAUDE_IMPORT_PAGE_BYTES,
    creditWaitExpired: true
  })
  // A non-empty array can use a larger length and different string alignment.
  return CLAUDE_IMPORT_PAGE_BYTES - frame.framed - 16
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
