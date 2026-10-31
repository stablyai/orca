import { createHash } from 'node:crypto'
import type { TranscriptMessage } from '../ai-vault/session-transcript-consumers'

// Forked transcripts share an opening prefix even after their tails diverge.
const CONTENT_HASH_MESSAGE_LIMIT = 8
// Require two messages so one shared opening prompt does not collapse unrelated sessions.
const CONTENT_HASH_MIN_MESSAGES = 2

export type SessionContentHash = { hash: string | null; count: number }

export const EMPTY_CONTENT_HASH: SessionContentHash = { hash: null, count: 0 }

/** Chain the opening-message digest across append reads, freezing it once the prefix limit is reached. */
export function foldContentHash(
  previous: SessionContentHash,
  messages: readonly TranscriptMessage[]
): SessionContentHash {
  let { hash, count } = previous
  for (const message of messages) {
    if (count >= CONTENT_HASH_MESSAGE_LIMIT) {
      break
    }
    hash = createHash('sha256')
      .update(hash ?? '')
      .update('\0')
      .update(message.role)
      .update('\0')
      .update(message.text)
      .digest('hex')
    count += 1
  }
  return { hash, count }
}

export function isCollapsibleContentHash(hash: string | null, count: number): hash is string {
  return hash !== null && count >= CONTENT_HASH_MIN_MESSAGES
}
