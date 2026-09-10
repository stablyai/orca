// Bounding a subagent entry's id — a KEY, not display text.
//
// `NativeChatSubagentEntry.id` keys the roster, so clipping it to a fixed prefix
// merges two distinct children whose ids agree that far and associates one's
// state with the other. An id long enough to need bounding only reaches us from
// an imported legacy transcript, but a bound is still required, so keep a head
// for readability plus a digest of the WHOLE id to keep distinct ids distinct.

import { createHash } from 'node:crypto'

/** Shared by every site that puts a roster entry on a wire, so a journal-bound
 *  id survives the RPC and transcript bounds untouched instead of being clipped
 *  a second time into a different string. */
export const MAX_SUBAGENT_ENTRY_ID_CHARS = 512

const DIGEST_CHARS = 16

/** Returns `id` unchanged when it fits, else a head plus a digest suffix whose
 *  total length is exactly the cap — so bounding a bounded id is a no-op. */
export function boundSubagentEntryId(id: string): string {
  if (id.length <= MAX_SUBAGENT_ENTRY_ID_CHARS) {
    return id
  }
  const digest = createHash('sha256').update(id, 'utf8').digest('base64url').slice(0, DIGEST_CHARS)
  const suffix = `…#${digest}`
  return `${id.slice(0, MAX_SUBAGENT_ENTRY_ID_CHARS - suffix.length)}${suffix}`
}
