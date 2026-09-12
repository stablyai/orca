import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import type { SessionParseReadRequirement } from '../ai-vault/session-scanner-parse-cache'
import { requiresWholeRead, type SessionSearchIndexedFile } from './session-search-file-cursor'
import type { SessionSearchFileRow } from './session-search-store'

/**
 * Failures at one unchanged stat before a file is left alone.
 *
 * Three rather than one, because a single failure is often a transcript being
 * rewritten under the read; three at the same mtime is not. The retry policy is
 * the stat itself: an edit, a restore, or a `touch` after a `chmod` all move it,
 * and nothing else does, so no timer is needed and none is kept.
 */
export const SESSION_SEARCH_FAILURES_BEFORE_HELD_OUT = 3

/**
 * What a pass owes one candidate: nothing, a read, or a read from the start.
 *
 * `any` and `whole` are the reader's own lanes. `whole` drops the session
 * list's resume point, which is the only way to reach a span this index never
 * saw; `any` asks for some bytes and lets the reader continue where it can,
 * which is what the first enablement inside a running app needs — a warm list
 * cursor sitting at the file's current stat would otherwise open nothing.
 */
export type SessionSearchReadDecision = 'skip' | SessionParseReadRequirement

/**
 * The whole of the indexer's decide step, as a function of the candidate's stat
 * and the row the store holds for it. No pass state, no queue, no memory: the
 * same inputs give the same answer on the first pass after a restart as on the
 * hundredth of a long-running process, which is what lets a deadline cut a pass
 * short with nothing to record. What did not get read is still owed, because
 * being owed is a fact about the row.
 */
export function sessionSearchReadDecision(args: {
  candidate: SessionFileCandidate
  /** The file table's row, or undefined when the index holds nothing for it. */
  row: SessionSearchFileRow | undefined
  /** The cursor for this candidate's identity; null when it is not continuable. */
  cursor: SessionSearchIndexedFile | null
  /** Oldest transcript mtime worth holding rows for, or null for all history. */
  cutoffMs: number | null
}): SessionSearchReadDecision {
  const { candidate, row, cursor, cutoffMs } = args
  const file = candidate.file
  // Retention first: a file outside the window is not worth reading whatever
  // else is true of it, and the purge is what removes any row it still has.
  if (cutoffMs !== null && file.mtimeMs < cutoffMs) {
    return 'skip'
  }
  if (!row) {
    // Nothing held for this path. Not `whole`, because the reader can continue
    // from wherever it likes: there is no span this index has to reach past.
    return 'any'
  }
  if (heldOut(row, file.mtimeMs)) {
    return 'skip'
  }
  if (row.state === 'due') {
    // The index is behind on a span no append reaches: a declined append, or a
    // window that widened to admit this file.
    return 'whole'
  }
  if (cursor === null || requiresWholeRead(cursor)) {
    // A different file at the same name, or a chunked read that left a prefix
    // and no cursor. Appending onto either would splice two spans together.
    return 'whole'
  }
  const size = file.sizeBytes
  if (typeof size === 'number' && cursor.byteOffset !== null && cursor.byteOffset > size) {
    // Shorter than the index read to: this is not the file that cursor came from.
    return 'whole'
  }
  if (row.state === 'failed') {
    // Still within its retries, or the stat moved since it last failed.
    return 'any'
  }
  return statMatches(row, file) ? 'skip' : 'any'
}

/**
 * True when this file has failed enough times at exactly this stat to stop
 * trying. The stat is the whole release condition, so a file nobody touches is
 * never read again and one that changes is read on the next pass that sees it.
 */
function heldOut(row: SessionSearchFileRow, mtimeMs: number): boolean {
  return (
    row.state === 'failed' &&
    row.failCount >= SESSION_SEARCH_FAILURES_BEFORE_HELD_OUT &&
    row.failedMtimeMs === mtimeMs
  )
}

/** The row already describes the file as it is now. */
function statMatches(row: SessionSearchFileRow, file: SessionFileCandidate['file']): boolean {
  return (
    row.mtimeMs === file.mtimeMs &&
    (row.sizeBytes === null || file.sizeBytes === undefined || row.sizeBytes === file.sizeBytes)
  )
}
