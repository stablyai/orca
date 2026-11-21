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

/** Absorbing history clears its failure; refused upload custody remains independent. */
export function recordJournalLegacyChatRevision(
  db: Database.Database,
  sessionId: string,
  revision: string
): void {
  db.prepare('INSERT OR REPLACE INTO agent_session_store_meta (key, value) VALUES (?, ?)').run(
    journalLegacyChatRevisionKey(sessionId),
    revision
  )
  clearJournalLegacyHistoryFailure(db, sessionId)
}

/** A chat, or a copy's history, that could not be kept, with its error; not retried by itself. */
export function journalLegacyFailureKey(sessionId: string): string {
  return `journal.legacy-failed:${sessionId}`
}

export type JournalLegacyFailureRecord = {
  revision: string | null
  error: string
  claims?: string
  adoption?: true
}

export function readJournalLegacyFailure(
  db: Database.Database,
  sessionId: string
): JournalLegacyFailureRecord | undefined {
  const row = db
    .prepare('SELECT value FROM agent_session_store_meta WHERE key=?')
    .get(journalLegacyFailureKey(sessionId))
  try {
    const value: unknown = row && JSON.parse(String(row.value))
    if (!value || typeof value !== 'object' || !('error' in value)) {
      return undefined
    }
    return {
      revision: 'revision' in value && typeof value.revision === 'string' ? value.revision : null,
      error: String(value.error),
      ...('claims' in value && typeof value.claims === 'string' ? { claims: value.claims } : {}),
      ...('adoption' in value && value.adoption === true ? { adoption: true as const } : {})
    }
  } catch {
    return undefined
  }
}

function clearJournalLegacyHistoryFailure(db: Database.Database, sessionId: string): void {
  const failure = readJournalLegacyFailure(db, sessionId)
  const key = journalLegacyFailureKey(sessionId)
  if (failure?.claims) {
    db.prepare('UPDATE agent_session_store_meta SET value=? WHERE key=?').run(
      JSON.stringify({ ...failure, revision: null, adoption: undefined }),
      key
    )
  } else {
    db.prepare('DELETE FROM agent_session_store_meta WHERE key=?').run(key)
  }
}

/** A copy kept for an original chat an older Orca continued converts its history from that chat. */
export function journalLegacyCopySourceKey(copyId: string): string {
  return `journal.legacy-copy-source:${copyId}`
}

/** The original chat a copy converts from, or the chat itself. */
export function journalLegacyConversionSource(db: Database.Database, sessionId: string): string {
  const row = db
    .prepare('SELECT value FROM agent_session_store_meta WHERE key=?')
    .get(journalLegacyCopySourceKey(sessionId))
  return row === undefined ? sessionId : String(row.value)
}

/** The copy kept for an original chat that hasn't converted here yet. */
export function journalLegacyPendingCopyKey(sessionId: string): string {
  return `journal.legacy-pending-copy:${sessionId}`
}

/** Once a copy is ready here its history no longer reads from the original. */
export function settleJournalLegacyCopy(db: Database.Database, copyId: string): void {
  const key = journalLegacyCopySourceKey(copyId)
  const original = db.prepare('SELECT value FROM agent_session_store_meta WHERE key=?').get(key)
  if (original === undefined) {
    return
  }
  db.prepare('DELETE FROM agent_session_store_meta WHERE key=?').run(key)
  clearJournalLegacyHistoryFailure(db, copyId)
  db.prepare('DELETE FROM agent_session_store_meta WHERE key=? AND value=?').run(
    journalLegacyPendingCopyKey(String(original.value)),
    copyId
  )
}
