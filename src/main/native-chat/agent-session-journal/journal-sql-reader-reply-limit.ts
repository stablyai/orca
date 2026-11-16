import { serialize } from 'node:v8'
import {
  describeWorkerMessage,
  isLargeWorkerMessage
} from '../../worker-threads/worker-message-shape'

/**
 * Main deserializes every reader reply into the V8 heap it shares with all workers; a decoded
 * whole-chat read (hundreds of MB) exhausts it and aborts Orca. Far above any paged read or the
 * full record set (~25 MB at 18k chats).
 */
export const JOURNAL_READER_REPLY_BYTE_LIMIT = 256 * 2 ** 20

/** Serialized size is measured only when the bounded walk already finds the reply large. */
export function journalReaderReplyExceedsLimit(
  reply: unknown,
  limit = JOURNAL_READER_REPLY_BYTE_LIMIT
): boolean {
  return isLargeWorkerMessage(describeWorkerMessage(reply)) && serialize(reply).byteLength > limit
}
