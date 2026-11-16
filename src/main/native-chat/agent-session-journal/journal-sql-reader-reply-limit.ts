import { serialize } from 'node:v8'
import {
  describeWorkerMessage,
  isLargeWorkerMessage
} from '../../worker-threads/worker-message-shape'

/**
 * Main deserializes every reader reply into the ~3.25 GB V8 heap it shares with all workers; a
 * decoded whole-chat read (647 MB of JSON, ~931 MB retained) exhausted it and aborted Orca.
 * Decoding costs 1.0-1.9x the serialized bytes (journal rows, records), so this keeps one reply
 * under ~120 MB of main heap, far above any paged read.
 */
export const JOURNAL_READER_REPLY_BYTE_LIMIT = 64 * 2 ** 20

/**
 * Serialized size is measured only when the bounded walk already finds the reply large. The
 * record set loads the chat store itself: refusing it would leave every chat unopenable, and it
 * grows only with the number of chats (~25 MB at 18k), so it is never refused here.
 */
export function journalReaderReplyExceedsLimit(
  reply: unknown,
  limit = JOURNAL_READER_REPLY_BYTE_LIMIT
): boolean {
  return (
    !isRecordSetReply(reply) &&
    isLargeWorkerMessage(describeWorkerMessage(reply)) &&
    serialize(reply).byteLength > limit
  )
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
