// Owner-checked retrieval of a retained bounded payload for one structured
// session. The payload store is process-wide and content-addressed, so a bare
// digest would be a cross-session oracle; a read is admitted only when the
// requesting session's own journal carries a row that references the digest.

import { existsSync } from 'node:fs'
import Database from '../../sqlite/sync-database'
import {
  PAYLOAD_READ_ERROR_CODES,
  type PayloadReadErrorCode
} from '../../../shared/journal-payload-read-errors'
import { journalRowReferencesDigest } from '../../../shared/journal-payload-reference'
import { journalDatabaseFile, journalDirectoryFor } from './journal-paths'
import {
  getDefaultJournalPayloadRetention,
  JournalPayloadIntegrityError,
  type JournalPayloadRange,
  type JournalPayloadRetention
} from './journal-payload-store'

export { PAYLOAD_READ_ERROR_CODES, type PayloadReadErrorCode }

/** A refusal a client can act on: it names which of the read's preconditions failed. */
export class PayloadReadError extends Error {
  readonly code: PayloadReadErrorCode
  /** Carries the precondition code alongside the message so a caller can branch. */
  constructor(code: PayloadReadErrorCode, message: string) {
    super(message)
    this.name = 'PayloadReadError'
    this.code = code
  }
}

export const DEFAULT_PAYLOAD_READ_LIMIT = 64 * 1024

/**
 * True when a row of `sessionId`'s journal references `digest` from one of the
 * reference fields Orca itself writes.
 *
 * The `LIKE` is only a prefilter: a session authors its own tool-call input, so
 * a row merely CONTAINING the digest text proves nothing. Ownership comes from
 * parsing each candidate and finding the digest at a position
 * `journal-payload-reference` recognises; otherwise a session could name a
 * foreign digest and read another session's retained bytes out of the
 * process-wide store.
 *
 * Every row of the session is scanned, with no epoch, revision or tombstone
 * filter: a row later revised to drop the reference, or tombstoned outright,
 * still admits the digest. That is deliberate. `journal_rows` is append-only
 * and the question here is ownership, not visibility — the payload is this
 * session's own in every such case, so admitting it discloses nothing the
 * session did not already retain. Hiding a row from the timeline is a
 * presentation decision; it is not a promise that the bytes were destroyed.
 */
export function journalReferencesDigest(journalDir: string, sessionId: string, digest: string): boolean {
  const dbPath = journalDatabaseFile(journalDir)
  if (!existsSync(dbPath)) {
    return false
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const rows = db
      .prepare(
        'SELECT row_json FROM journal_rows WHERE session_id = ? AND row_json LIKE ? ORDER BY seq ASC'
      )
      .all(sessionId, `%"${digest}"%`)
    for (const row of rows) {
      if (journalRowReferencesDigest(parseRowJson(row), digest)) {
        return true
      }
    }
    return false
  } finally {
    db.close()
  }
}

/** A row this build cannot parse references nothing; it never widens a read. */
function parseRowJson(row: unknown): unknown {
  if (typeof row !== 'object' || row === null || !('row_json' in row)) {
    return null
  }
  const json = row.row_json
  if (typeof json !== 'string') {
    return null
  }
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}

/**
 * One byte range of a retained payload, for a caller that can prove ownership.
 * `isReferenced` is the proof and is consulted BEFORE the store is touched, so a
 * caller who cannot prove it learns nothing about whether the bytes exist.
 */
export function readOwnedPayloadRange(input: {
  retention?: JournalPayloadRetention | null
  isReferenced: () => boolean
  digest: string
  offset?: number
  limit?: number
  maxLimit: number
}): JournalPayloadRange {
  const retention = input.retention === undefined
    ? getDefaultJournalPayloadRetention() : input.retention
  if (retention === null) {
    throw new PayloadReadError('payload_not_retained',
      'This host retains no bounded payloads; the truncated head is all that exists.')
  }
  // The reference check runs BEFORE the store is touched, and a missing
  // reference and a missing file share one code so the store is no oracle.
  if (!input.isReferenced()) {
    throw new PayloadReadError('payload_not_referenced',
      `Digest ${input.digest.slice(0, 12)} is not referenced by the requested owner.`)
  }
  const limit = Math.min(input.limit ?? DEFAULT_PAYLOAD_READ_LIMIT, input.maxLimit)
  let range: JournalPayloadRange | null
  try {
    range = retention.retrieveRange(input.digest, input.offset ?? 0, limit)
  } catch (error) {
    if (error instanceof JournalPayloadIntegrityError) {
      throw new PayloadReadError('payload_integrity_failed', error.message)
    }
    throw error
  }
  if (range === null) {
    throw new PayloadReadError('payload_not_referenced',
      `Digest ${input.digest.slice(0, 12)} is not retained for the requested owner.`)
  }
  return range
}

/** The two identity fields a session-scoped read consults. */
export type PayloadJournalOwner = { sessionId: string; workspaceId: string }

/** Session-scoped read: the session's own journal must reference the digest. */
export function readSessionPayload(input: {
  journalRoot: string
  owner: PayloadJournalOwner
  digest: string
  offset?: number
  limit?: number
  maxLimit: number
  retention?: JournalPayloadRetention | null
}): JournalPayloadRange {
  const journalDir = journalDirectoryFor(input.journalRoot, {
    workspaceId: input.owner.workspaceId,
    sessionId: input.owner.sessionId
  })
  return readOwnedPayloadRange({
    retention: input.retention,
    // The session's own journal is the proof; see journalReferencesDigest.
    isReferenced: () => journalReferencesDigest(journalDir, input.owner.sessionId, input.digest),
    digest: input.digest,
    offset: input.offset,
    limit: input.limit,
    maxLimit: input.maxLimit
  })
}
