import type { SessionFileCandidate } from '../../ai-vault/session-scanner-types'
import type { SessionParseReadRequirement } from '../../ai-vault/parse-cache/session-scanner-parse-cache'
import {
  requiresWholeRead,
  type SessionSearchIndexedFile
} from '../storage/session-search-file-cursor'
import type { SessionSearchFileRow } from '../storage/session-search-store-types'

// Allow transient rewrite failures before holding out a file at an unchanged mtime.
export const SESSION_SEARCH_FAILURES_BEFORE_HELD_OUT = 3

// Retry a stat-frozen holdout at this interval; permissions can return without any stat moving.
export const SESSION_SEARCH_FAILED_RETRY_BACKOFF_MS = 60_000

/** any forces a read; whole also discards the session-list resume point to recover missing spans. */
export type SessionSearchReadDecision = 'skip' | SessionParseReadRequirement

/**
 * Whether an indexed file must be read again. Metadata-keyed agents (kiro/cline/ante style) keep
 * their messages in a sidecar, so a transcript that grew after the metadata snapshot is a change
 * even when this file's own stat is untouched.
 */
export function sessionSearchReadDecision(args: {
  candidate: SessionFileCandidate
  row: SessionSearchFileRow | undefined
  /** Identity-checked cursor; null means missing or replaced, while a null offset marks a partial read. */
  cursor: SessionSearchIndexedFile | null
  /** Oldest transcript mtime to index; null means all history. */
  cutoffMs: number | null
  /** Clock for the failure backoff; the system clock when absent. */
  nowMs?: number
}): SessionSearchReadDecision {
  const { candidate, row, cursor, cutoffMs } = args
  const file = candidate.file
  // Purging removes expired rows; avoid reading files that would immediately expire again.
  if (cutoffMs !== null && file.mtimeMs < cutoffMs) {
    return 'skip'
  }
  if (!row) {
    return 'any'
  }
  if (heldOut(row, file, args.nowMs)) {
    return 'skip'
  }
  if (row.state === 'due') {
    // Appending cannot recover a span the index missed.
    return 'whole'
  }
  if (cursor === null || requiresWholeRead(cursor)) {
    // Replaced files and incomplete prefixes cannot safely continue an append.
    return 'whole'
  }
  const size = file.sizeBytes
  if (typeof size === 'number' && cursor.byteOffset !== null && cursor.byteOffset > size) {
    return 'whole'
  }
  if (row.state === 'failed') {
    return 'any'
  }
  if (!sidecarStatMatches(row, candidate.file.sidecar)) {
    // The messages live outside this file; rereading is the only way to publish the appended turn.
    return 'any'
  }
  return statMatches(row, file) ? 'skip' : 'any'
}

/**
 * Compare the sidecar stat recorded by the last committed read with this scan's observation.
 * Rows written before the stat was persisted read back as null, which misses once so the append
 * they may already hold is indexed.
 */
function sidecarStatMatches(
  row: SessionSearchFileRow,
  sidecar: SessionFileCandidate['file']['sidecar']
): boolean {
  // Absent or missing declares no sidecar, so only the metadata stat can decide.
  if (sidecar === undefined || sidecar === 'none') {
    return row.sidecarMtimeMs === null && row.sidecarSizeBytes === null
  }
  // An unreadable sidecar proves nothing about the indexed content.
  if (sidecar === 'unknown') {
    return false
  }
  return row.sidecarMtimeMs === sidecar.mtimeMs && row.sidecarSizeBytes === sidecar.sizeBytes
}

/**
 * A held-out file is retried when its own stat or the sidecar stat its last read saw has moved, or
 * once the failure backoff expires: a restored permission leaves both stats frozen.
 */
function heldOut(
  row: SessionSearchFileRow,
  file: SessionFileCandidate['file'],
  nowMs = Date.now()
): boolean {
  if (
    row.state !== 'failed' ||
    row.failCount < SESSION_SEARCH_FAILURES_BEFORE_HELD_OUT ||
    row.failedMtimeMs !== file.mtimeMs ||
    !failedSidecarMatches(row, file.sidecar)
  ) {
    return false
  }
  // Rows that failed before the clock column was added read back as null and miss once; that retry
  // stamps the clock, so the backoff bounds how often such a file is reread.
  return row.failedAtMs !== null && nowMs - row.failedAtMs < SESSION_SEARCH_FAILED_RETRY_BACKOFF_MS
}

/**
 * Compare the sidecar stat recorded by the last failed read with this scan's observation. An unknown
 * sidecar proves nothing either way, so it must not defeat the holdout and re-read every scan; only
 * the backoff releases it. A current row with an unknown sidecar still rereads via
 * {@link sidecarStatMatches}, which is where an unprovable change gets noticed.
 */
function failedSidecarMatches(
  row: SessionSearchFileRow,
  sidecar: SessionFileCandidate['file']['sidecar']
): boolean {
  if (sidecar === 'unknown') {
    return true
  }
  if (sidecar === undefined || sidecar === 'none') {
    return row.failedSidecarMtimeMs === null && row.failedSidecarSizeBytes === null
  }
  return (
    row.failedSidecarMtimeMs === sidecar.mtimeMs && row.failedSidecarSizeBytes === sidecar.sizeBytes
  )
}

/** A committed row still covers this file when its stat has not moved since the read. */
function statMatches(row: SessionSearchFileRow, file: SessionFileCandidate['file']): boolean {
  return (
    row.mtimeMs === file.mtimeMs &&
    (row.sizeBytes === null || file.sizeBytes === undefined || row.sizeBytes === file.sizeBytes)
  )
}
