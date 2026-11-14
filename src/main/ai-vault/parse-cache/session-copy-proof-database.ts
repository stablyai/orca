import type { SessionCopyProof } from './session-copy-proof'
import { parseSessionCacheIdentity } from './session-cache-evidence'

export function parseSessionCopyProofRow(
  row: Record<string, unknown> | undefined
): SessionCopyProof | undefined {
  if (
    !row ||
    typeof row.mtime_ms !== 'number' ||
    (row.size_bytes !== null && typeof row.size_bytes !== 'number') ||
    typeof row.session_id !== 'string'
  ) {
    return undefined
  }
  return {
    ...parseSessionCacheIdentity(row.identity),
    mtimeMs: row.mtime_ms,
    sizeBytes: row.size_bytes,
    sessionId: row.session_id
  }
}
