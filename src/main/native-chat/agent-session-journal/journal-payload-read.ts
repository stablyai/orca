// Owner-checked retrieval of a retained bounded payload for one structured
// session. The payload store is process-wide and content-addressed, so a bare
// digest would be a cross-session oracle; a read is admitted only when the
// requesting session's own journal carries a row that references the digest.

import { existsSync } from 'node:fs'
import Database from '../../sqlite/sync-database'
import { journalDatabaseFile, journalDirectoryFor } from './journal-paths'
import {
  getDefaultJournalPayloadRetention,
  JournalPayloadIntegrityError,
  type JournalPayloadRange,
  type JournalPayloadRetention
} from './journal-payload-store'

export const PAYLOAD_READ_ERROR_CODES = [
  'payload_not_referenced',
  'payload_not_retained',
  'payload_integrity_failed',
  'payload_read_unsupported'
] as const
export type PayloadReadErrorCode = (typeof PAYLOAD_READ_ERROR_CODES)[number]

export class PayloadReadError extends Error {
  readonly code: PayloadReadErrorCode
  constructor(code: PayloadReadErrorCode, message: string) {
    super(message)
    this.name = 'PayloadReadError'
    this.code = code
  }
}

export const DEFAULT_PAYLOAD_READ_LIMIT = 64 * 1024

/** True when a row of `sessionId`'s journal names `digest` as a bounded payload. */
export function journalReferencesDigest(journalDir: string, sessionId: string, digest: string): boolean {
  const dbPath = journalDatabaseFile(journalDir)
  if (!existsSync(dbPath)) {
    return false
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const row = db
      .prepare(
        'SELECT 1 AS hit FROM journal_rows WHERE session_id = ? AND row_json LIKE ? LIMIT 1'
      )
      .get(sessionId, `%"digest":"${digest}"%`)
    return row !== undefined
  } finally {
    db.close()
  }
}

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
    isReferenced: () => journalReferencesDigest(journalDir, input.owner.sessionId, input.digest),
    digest: input.digest,
    offset: input.offset,
    limit: input.limit,
    maxLimit: input.maxLimit
  })
}
