// Process-wide default retention used by every bounding call site that does not
// pass its own, plus digest-keyed retrieval through it.

import { createHash } from 'node:crypto'
import type { JournalPayloadRetention } from './journal-payload-store'

let defaultRetention: JournalPayloadRetention | null = null

/** Install the process-wide retention used by every bounding call site that
 *  does not pass its own. Null disables retention (rows stay
 *  `retrievable: false`). */
export function setDefaultJournalPayloadRetention(
  retention: JournalPayloadRetention | null
): void {
  defaultRetention = retention
}

/** The process-wide retention, or null on a host that retains nothing — in which
 *  case a clipped row's remainder was genuinely discarded. */
export function getDefaultJournalPayloadRetention(): JournalPayloadRetention | null {
  return defaultRetention
}

/** Retrieve a retained original by digest through the default retention.
 *  Returns null when nothing is retained; throws on integrity mismatch. */
export function retrieveJournalPayload(digest: string): string | null {
  if (defaultRetention === null) {
    return null
  }
  return defaultRetention.retrieve(digest)
}

/** Digest of a payload as the store keys it (sha256 hex of UTF-8 bytes). */
export function journalPayloadDigest(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex')
}
