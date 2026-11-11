import type SyncDatabase from '../sqlite/sync-database'
import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import type { SessionSearchResumableCursor } from './storage/session-search-store-types'
import { fileIdentity } from './storage/session-search-file-cursor'
import { asRecord } from '../ai-vault/session-scanner-record-value'

/** A cold list read must not rewrite a complete, unchanged search entry. */
export function coversSessionSearchTranscript(
  db: SyncDatabase,
  candidate: SessionFileCandidate,
  closed: boolean,
  onError: (error: unknown) => void
): boolean {
  const file = candidate.file
  if (closed || typeof file.sizeBytes !== 'number') {
    return false
  }
  const identity = fileIdentity(file)
  try {
    return (
      db
        .prepare(
          // With a known file identity, a missing stored identity must force a rewrite.
          `SELECT 1 FROM files WHERE path = ? AND state = 'current'
           AND mtime_ms = ? AND size_bytes = ? AND byte_offset = size_bytes
           AND (? IS NULL OR (CAST(dev AS REAL) = ? AND CAST(ino AS REAL) = ?))`
        )
        .get(
          file.path,
          file.mtimeMs,
          file.sizeBytes,
          identity?.dev ?? null,
          identity?.dev ?? null,
          identity?.ino ?? null
        ) !== undefined
    )
  } catch (error) {
    onError(error)
    return false
  }
}

/** A current cursor with bytes past it, and the hash a replacement read must reproduce to append there. */
export function sessionSearchResumableCursor(
  db: SyncDatabase,
  candidate: SessionFileCandidate,
  closed: boolean,
  onError: (error: unknown) => void
): SessionSearchResumableCursor | null {
  const file = candidate.file
  if (closed || typeof file.sizeBytes !== 'number') {
    return null
  }
  const identity = fileIdentity(file)
  try {
    const row = asRecord(
      db
        .prepare(
          `SELECT byte_offset AS byteOffset, prefix_hash AS prefixHash FROM files
             WHERE path = ? AND state = 'current' AND prefix_hash IS NOT NULL
             AND byte_offset > 0 AND byte_offset < ?
             AND (? IS NULL OR (CAST(dev AS REAL) = ? AND CAST(ino AS REAL) = ?))`
        )
        .get(
          file.path,
          file.sizeBytes,
          identity?.dev ?? null,
          identity?.dev ?? null,
          identity?.ino ?? null
        )
    )
    return typeof row?.byteOffset === 'number' && typeof row.prefixHash === 'string'
      ? { byteOffset: row.byteOffset, prefixHash: row.prefixHash }
      : null
  } catch (error) {
    onError(error)
    return null
  }
}
