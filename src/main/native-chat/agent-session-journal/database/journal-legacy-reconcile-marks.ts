import { createHash } from 'node:crypto'
import type Database from '../../../sqlite/sync-database'
import {
  journalLegacyCopySourceKey,
  journalLegacyFailureKey,
  journalLegacyPendingCopyKey,
  recordJournalLegacyChatRevision
} from './journal-legacy-source'

/** A converted chat with no revision to compare whose original moved; compared in the background. */
export const JOURNAL_LEGACY_COMPARE = 'journal.legacy-compare:'
/** Compared and found to hold turns this file lacks; the next open keeps them as a copy. */
export const JOURNAL_LEGACY_COPY_DUE = 'journal.legacy-copy-due:'

export type JournalLegacyFailure = {
  sessionId: string
  revision: string | undefined
  error: unknown
}

/** Absorbed with its error: retried only when the older Orca writes this chat again. */
export function recordJournalLegacyFailure(
  db: Database.Database,
  failure: JournalLegacyFailure
): void {
  console.warn('[agent-session-journal] keeping an older Orca chat failed', failure.error)
  if (failure.revision !== undefined) {
    recordJournalLegacyChatRevision(db, failure.sessionId, failure.revision)
  }
  writeMeta(
    db,
    journalLegacyFailureKey(failure.sessionId),
    JSON.stringify({ revision: failure.revision ?? null, error: failureMessage(failure.error) })
  )
  deleteMeta(db, `${JOURNAL_LEGACY_COPY_DUE}${failure.sessionId}`)
}

export function failureMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500)
}

export function readMeta(db: Database.Database, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM agent_session_store_meta WHERE key=?').get(key)
  return row === undefined ? undefined : String(row.value)
}

export function metaKeys(db: Database.Database, prefix: string): string[] {
  return db
    .prepare('SELECT key FROM agent_session_store_meta WHERE key>? AND key<? ORDER BY key')
    .all(prefix, prefixEnd(prefix))
    .map((row) => String(row.key).slice(prefix.length))
}

/** Keys here are ASCII and every prefix ends in ':', so ';' bounds its range. */
export function prefixEnd(prefix: string): string {
  return `${prefix.slice(0, -1)};`
}

export function deleteMeta(db: Database.Database, key: string): void {
  db.prepare('DELETE FROM agent_session_store_meta WHERE key=?').run(key)
}

export function writeMeta(db: Database.Database, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO agent_session_store_meta (key, value) VALUES (?, ?)').run(
    key,
    value
  )
}

/** Derived from the revision, so a pass interrupted after making it finds the same chat. */
export function continuedCopyId(id: string, revision: string): string {
  return createHash('sha256').update(`${id}\0${revision}`).digest('hex').slice(0, 32)
}

/** A copy of this original chat still waiting to convert reads the current original. */
export function holdsPendingCopy(db: Database.Database, id: string): boolean {
  const copy = readMeta(db, journalLegacyPendingCopyKey(id))
  return (
    copy !== undefined &&
    db
      .prepare(`SELECT 1 FROM agent_session_records WHERE session_id=?1 AND NOT EXISTS (
        SELECT 1 FROM journal_chat_state WHERE session_id=?1 AND epoch IS NOT NULL)`)
      .get(copy) !== undefined
  )
}

const COPY_SOURCE = journalLegacyCopySourceKey('')

/**
 * Copies another build readied before this one converted them: an older build that can't read
 * the mapping founds them empty. Conversion here clears the mapping, so only those remain.
 */
export function strandedCopies(db: Database.Database): [original: string, copy: string][] {
  const mapped = db
    .prepare('SELECT key, value FROM agent_session_store_meta WHERE key>? AND key<?')
    .all(COPY_SOURCE, prefixEnd(COPY_SOURCE))
  if (mapped.length === 0) {
    return []
  }
  const founded = db.prepare(
    'SELECT 1 FROM journal_chat_state WHERE session_id=? AND epoch IS NOT NULL'
  )
  return mapped
    .map((row): [string, string] => [String(row.value), String(row.key).slice(COPY_SOURCE.length)])
    .filter(([, copy]) => founded.get(copy) !== undefined)
}

/** An original chat whose current epoch saved no row has nothing to keep. */
export function revisionHoldsHistory(revision: string): boolean {
  const parsed: unknown = JSON.parse(revision)
  return Array.isArray(parsed) && parsed[1] !== 0
}
