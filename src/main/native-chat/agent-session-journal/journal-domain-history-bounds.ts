import type Database from '../../sqlite/sync-database'
import type { JournalDomainHistoryMetadata } from './journal-domain-history-metadata'

type HistoryTarget = { sessionId: string; epoch: string }

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
  if (metadata.namedSubagentIds.length === 0) {
    return
  }
  const row = db
    .prepare(`SELECT sequence, sequence_index, ordinal, hidden FROM journal_items
    WHERE session_id=? AND epoch=? AND item_id=? AND root=1`)
    .get(...key)
  if (!row) {
    return
  }
  const insert = db.prepare(`INSERT OR IGNORE INTO journal_item_subagent_names(
      session_id,epoch,subagent_id,item_id,sequence,sequence_index,ordinal,hidden)
    VALUES(?,?,?,?,?,?,?,?)`)
  for (const subagentId of metadata.namedSubagentIds) {
    insert.run(
      target.sessionId,
      target.epoch,
      subagentId,
      itemId,
      row.sequence,
      row.sequence_index,
      row.ordinal,
      row.hidden
    )
  }
}
