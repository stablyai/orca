import type Database from '../../sqlite/sync-database'
import type { JournalWriterTarget } from './journal-writer-command'
import { AgentSessionJournalError } from './journal-write-guards'

export function journalSqlMetaSchema(): string {
  return `CREATE TABLE IF NOT EXISTS journal_proj_meta (
    session_id TEXT PRIMARY KEY,
    epoch TEXT NOT NULL,
    generation TEXT NOT NULL,
    through_seq INTEGER NOT NULL,
    owner_token TEXT NOT NULL
  ) WITHOUT ROWID;`
}

/** Ownership and epoch are checked again within every command's transaction. */
export function readJournalSqlMeta(db: Database.Database, target: JournalWriterTarget) {
  const row = db
    .prepare(`SELECT p.generation, p.through_seq FROM journal_proj_meta p
    JOIN journal_sessions s ON s.session_id=p.session_id AND s.epoch=p.epoch
    WHERE p.session_id=? AND p.epoch=? AND p.owner_token=?`)
    .get(target.sessionId, target.epoch, target.ownerToken)
  if (typeof row?.generation !== 'string' || typeof row.through_seq !== 'number') {
    throw new AgentSessionJournalError(
      'journal_closed',
      'the chat projection is no longer owned by this handle'
    )
  }
  return { generation: row.generation, through: row.through_seq }
}
