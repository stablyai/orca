import Database from '../../../sqlite/sync-database'
import { ensureJournalAdditiveTables, journalPragmaNumber } from './journal-database'
import { createAgentSessionRecordTablesSql } from './journal-database-schema'

/**
 * Opens the original journal read-only, shaped as this build's writable open would have left it.
 * A table an older build never added reads as empty through a private TEMP table, so the file
 * itself is never written. Columns added later are optional in their row readers.
 */
export function openJournalLegacySource(
  filename: string,
  options: { timeout?: number } = {}
): Database.Database {
  const source = new Database(filename, { readonly: true, fileMustExist: true, ...options })
  try {
    presentCurrentSchema(source)
    return source
  } catch (error) {
    source.close()
    throw error
  }
}

function presentCurrentSchema(source: Database.Database): void {
  const current = new Database(':memory:')
  try {
    current.exec(createAgentSessionRecordTablesSql())
    // Schema 4 created its record tables with its version; a version-4 file without them is damaged.
    const required = journalPragmaNumber(source, 'user_version') >= 4 ? tableNames(current) : []
    ensureJournalAdditiveTables(current)
    const tables = current
      .prepare(
        "SELECT name, sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'"
      )
      .all()
    for (const { name, sql } of tables) {
      if (
        !required.includes(String(name)) &&
        !source.prepare('SELECT 1 FROM main.sqlite_schema WHERE name=?').get(name)
      ) {
        source.exec(String(sql).replace(/^CREATE TABLE /, 'CREATE TEMP TABLE '))
      }
    }
  } finally {
    current.close()
  }
}

function tableNames(db: Database.Database): string[] {
  return db
    .prepare("SELECT name FROM sqlite_schema WHERE type='table'")
    .all()
    .map(({ name }) => String(name))
}

/**
 * Where an original chat's history stands: its epoch, input tip and outcome coverage. Every turn an
 * older Orca saves moves one of them, so an unchanged value means nothing new was written.
 */
export function journalLegacyChatRevision(
  source: Database.Database,
  sessionId: string
): string | null {
  const session = source
    .prepare('SELECT epoch FROM journal_sessions WHERE session_id=?')
    .get(sessionId)
  if (!session) {
    return null
  }
  const tip = source
    .prepare(
      'SELECT seq FROM journal_rows WHERE session_id=? AND epoch=? ORDER BY seq DESC LIMIT 1'
    )
    .get(sessionId, session.epoch)
  const outcomes = source
    .prepare(
      'SELECT generation,through_seq FROM journal_outcome_epochs WHERE session_id=? AND epoch=?'
    )
    .get(sessionId, session.epoch)
  return JSON.stringify([
    session.epoch,
    tip?.seq ?? 0,
    outcomes?.generation ?? null,
    outcomes?.through_seq ?? null
  ])
}

/** The original chat revision whose turns this file already shows, keyed by the original's id. */
export function journalLegacyChatRevisionKey(sessionId: string): string {
  return `journal.legacy-revision:${sessionId}`
}

export function recordJournalLegacyChatRevision(
  db: Database.Database,
  sessionId: string,
  revision: string
): void {
  db.prepare('INSERT OR REPLACE INTO agent_session_store_meta (key, value) VALUES (?, ?)').run(
    journalLegacyChatRevisionKey(sessionId),
    revision
  )
}
