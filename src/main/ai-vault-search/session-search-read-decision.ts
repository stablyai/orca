import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import type { SessionParseReadRequirement } from '../ai-vault/session-scanner-parse-cache'
import { requiresWholeRead, type SessionSearchIndexedFile } from './session-search-file-cursor'
import type { SessionSearchFileRow } from './session-search-store'

// Allow transient rewrite failures before holding out a file at an unchanged mtime.
export const SESSION_SEARCH_FAILURES_BEFORE_HELD_OUT = 3

/** any forces a read; whole also discards the session-list resume point to recover missing spans. */
export type SessionSearchReadDecision = 'skip' | SessionParseReadRequirement

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
  if (heldOut(row, file.mtimeMs)) {
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
  return statMatches(row, file) ? 'skip' : 'any'
}

/** A held-out file is retried only when its mtime changes. */
function heldOut(row: SessionSearchFileRow, mtimeMs: number): boolean {
  return (
    row.state === 'failed' &&
    row.failCount >= SESSION_SEARCH_FAILURES_BEFORE_HELD_OUT &&
    row.failedMtimeMs === mtimeMs
  )
}

function statMatches(row: SessionSearchFileRow, file: SessionFileCandidate['file']): boolean {
  return (
    row.mtimeMs === file.mtimeMs &&
    (row.sizeBytes === null || file.sizeBytes === undefined || row.sizeBytes === file.sizeBytes)
  )
}
