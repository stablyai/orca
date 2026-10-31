// IDs are roster keys: hash the whole value when bounding so shared prefixes cannot merge children.

import { createHash } from 'node:crypto'

/** Use the same cap at journal/RPC/transcript boundaries to avoid rebounding into a different key. */
export const MAX_SUBAGENT_ENTRY_ID_CHARS = 512

const DIGEST_CHARS = 16

/** Keep bounded IDs unchanged; oversized IDs retain a readable head and whole-ID digest. */
export function boundSubagentEntryId(id: string): string {
  if (id.length <= MAX_SUBAGENT_ENTRY_ID_CHARS) {
    return id
  }
  const digest = createHash('sha256').update(id, 'utf8').digest('base64url').slice(0, DIGEST_CHARS)
  const suffix = `…#${digest}`
  return `${id.slice(0, MAX_SUBAGENT_ENTRY_ID_CHARS - suffix.length)}${suffix}`
}
