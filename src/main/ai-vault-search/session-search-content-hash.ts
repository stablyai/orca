import { createHash } from 'node:crypto'
import type { SessionSearchCapturedMessage } from '../ai-vault/session-search-capture'

// Why: Claude `--resume` and Codex fork copy the parent transcript into a new
// file under a new session id, so one conversation lands N times in results.
// The shared opening prefix is what identifies the copy; the tail diverges.
export const CONTENT_HASH_MESSAGE_LIMIT = 8
// One shared opening prompt is not evidence of a fork; two turns is.
export const CONTENT_HASH_MIN_MESSAGES = 2

export type SessionContentHash = { hash: string | null; count: number }

export const EMPTY_CONTENT_HASH: SessionContentHash = { hash: null, count: 0 }

/**
 * Chained digest over the first `CONTENT_HASH_MESSAGE_LIMIT` messages. Chaining
 * (rather than hashing one joined string) makes it resumable, so an `append`
 * can finish a prefix a short `replace` started; once the limit is reached the
 * value is frozen and later appends leave it untouched.
 */
export function foldContentHash(
  previous: SessionContentHash,
  messages: readonly SessionSearchCapturedMessage[]
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

/** Sessions collapse only on a hash that covers enough turns to mean anything. */
export function isCollapsibleContentHash(hash: string | null, count: number): hash is string {
  return hash !== null && count >= CONTENT_HASH_MIN_MESSAGES
}
