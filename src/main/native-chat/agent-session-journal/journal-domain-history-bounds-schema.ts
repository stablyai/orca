import type Database from '../../sqlite/sync-database'
import type { SqliteBindings } from '../../sqlite/sqlite-statement'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import {
  journalDomainHistoryMetadata,
  type JournalDomainHistoryMetadata
} from './journal-domain-history-metadata'

type HistoryTarget = { sessionId: string; epoch: string }

/** Next numbered migration body: sent sizes and subagent names history selects before any body. */
export function migrateJournalDomainHistoryBounds(db: Database.Database): void {
  db.exec(`
ALTER TABLE journal_items ADD COLUMN wire_bytes INTEGER;
CREATE TABLE journal_item_subagent_names (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  subagent_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  PRIMARY KEY(session_id, epoch, subagent_id, item_id)
) WITHOUT ROWID;
CREATE INDEX journal_item_subagent_names_item ON journal_item_subagent_names(session_id, epoch, item_id);
DROP INDEX journal_items_named_subagents;
`)
  const page = db.prepare(`SELECT session_id, epoch, item_id, payload_json FROM journal_items
    WHERE (session_id, epoch, item_id) > (?, ?, ?) ORDER BY session_id, epoch, item_id LIMIT 500`)
  let after: SqliteBindings = ['', '', '']
  for (let rows = page.all(...after); rows.length > 0; rows = page.all(...after)) {
    for (const row of rows) {
      const payload = String(row.payload_json)
      const item: AgentJournalRenderItem = JSON.parse(payload)
      writeJournalDomainHistoryBounds(
        db,
        { sessionId: String(row.session_id), epoch: String(row.epoch) },
        String(row.item_id),
        journalDomainHistoryMetadata(item, payload)
      )
    }
    const last = rows.at(-1)!
    after = [last.session_id, last.epoch, last.item_id]
  }
}

/** Every journal_items upsert calls this after writing the row, in the same transaction. */
export function writeJournalDomainHistoryBounds(
  db: Database.Database,
  target: HistoryTarget,
  itemId: string,
  metadata: Pick<JournalDomainHistoryMetadata, 'wireBytes' | 'namedSubagentIds'>
): void {
  const key = [target.sessionId, target.epoch, itemId] as const
  db.prepare(
    'UPDATE journal_items SET wire_bytes=? WHERE session_id=? AND epoch=? AND item_id=?'
  ).run(metadata.wireBytes, ...key)
  db.prepare(
    'DELETE FROM journal_item_subagent_names WHERE session_id=? AND epoch=? AND item_id=?'
  ).run(...key)
  const insert =
    db.prepare(`INSERT OR IGNORE INTO journal_item_subagent_names(session_id,epoch,subagent_id,item_id)
    VALUES(?,?,?,?)`)
  const named: string[] = JSON.parse(metadata.namedSubagentIds ?? '[]')
  for (const subagentId of named) {
    insert.run(target.sessionId, target.epoch, subagentId, itemId)
  }
}
