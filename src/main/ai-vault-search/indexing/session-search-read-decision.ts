import type { SessionFileCandidate } from '../../ai-vault/session-scanner-types'
import type { SessionParseReadRequirement } from '../../ai-vault/parse-cache/session-scanner-parse-cache'
import {
  requiresWholeRead,
  type SessionSearchIndexedFile
} from '../storage/session-search-file-cursor'
import type { SessionSearchFileRow } from '../storage/session-search-store-types'

// Allow transient rewrite failures before holding out a file at an unchanged mtime.
export const SESSION_SEARCH_FAILURES_BEFORE_HELD_OUT = 3

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
  if (heldOut(row, file)) {
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
 * A held-out file is retried when its own stat or the sidecar stat its last read saw has moved.
 * Stamping only the metadata mtime would silence an agent whose metadata never changes again while
 * its transcript keeps growing, and a null sidecar stamp (a pre-column row, or a read that saw no
 * sidecar) must miss once so a sidecar append cannot stay invisible forever.
 */
function heldOut(row: SessionSearchFileRow, file: SessionFileCandidate['file']): boolean {
  return (
    row.state === 'failed' &&
    row.failCount >= SESSION_SEARCH_FAILURES_BEFORE_HELD_OUT &&
    row.failedMtimeMs === file.mtimeMs &&
    failedSidecarMatches(row, file.sidecar)
  )
}

function failedSidecarMatches(
  row: SessionSearchFileRow,
  sidecar: SessionFileCandidate['file']['sidecar']
): boolean {
  if (sidecar === undefined || sidecar === 'none' || sidecar === 'unknown') {
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
