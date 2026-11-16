import { createHash } from 'node:crypto'
import type Database from '../../../sqlite/sync-database'
import {
  journalLegacyCopySourceKey,
  recordJournalLegacyChatRevision
} from './journal-legacy-source'

/** A converted chat with no revision to compare whose original moved; compared in the background. */
export const JOURNAL_LEGACY_COMPARE = 'journal.legacy-compare:'
/** Compared and found to hold turns this file lacks; the next open keeps them as a copy. */
export const JOURNAL_LEGACY_COPY_DUE = 'journal.legacy-copy-due:'
/** A chat that could not be kept, with its error; absorbed until the original moves again. */
export const JOURNAL_LEGACY_FAILED = 'journal.legacy-failed:'

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
  const message = failure.error instanceof Error ? failure.error.message : String(failure.error)
  writeMeta(
    db,
    `${JOURNAL_LEGACY_FAILED}${failure.sessionId}`,
    JSON.stringify({ revision: failure.revision ?? null, error: message.slice(0, 500) })
  )
  if (failure.revision !== undefined) {
    recordJournalLegacyChatRevision(db, failure.sessionId, failure.revision)
  }
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

export function awaitsConversion(db: Database.Database, id: string, copy: string): boolean {
  return (
    readMeta(db, journalLegacyCopySourceKey(copy)) === id &&
    db
      .prepare(`SELECT 1 FROM agent_session_records WHERE session_id=?1 AND NOT EXISTS (
        SELECT 1 FROM journal_chat_state WHERE session_id=?1 AND epoch IS NOT NULL)`)
      .get(copy) !== undefined
  )
}

/** An original chat whose current epoch saved no row has nothing to keep. */
export function revisionHoldsHistory(revision: string): boolean {
  const parsed: unknown = JSON.parse(revision)
  return Array.isArray(parsed) && parsed[1] !== 0
}
