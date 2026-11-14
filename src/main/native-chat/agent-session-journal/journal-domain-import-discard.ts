import { JOURNAL_EPOCH_TABLES } from './journal-domain-maintenance'
import { journalForkStageHeld } from './journal-fork-stage-state'
import type Database from '../../sqlite/sync-database'

export type JournalDomainImportDiscard = { more: boolean; epoch: string | null }

/** An unready import owns only these chat rows; profile metadata and ready chats are untouched. */
export function discardJournalDomainImportPage(
  db: Database.Database,
  sessionId: string
): JournalDomainImportDiscard {
  if (!db.isTransaction) {
    throw new Error('journal import discard requires its writer transaction')
  }
  if (journalForkStageHeld(db, sessionId)) {
    return { more: false, epoch: null }
  }
  const ready = db.prepare('SELECT epoch FROM journal_chat_state WHERE session_id=?').get(sessionId)
  if (ready?.epoch !== null && ready?.epoch !== undefined) {
    return { more: false, epoch: String(ready.epoch) }
  }
  const start = performance.now()
  let deleted = 0
  let bytes = 0
  for (const { name, key, payload } of JOURNAL_EPOCH_TABLES) {
    const columns = ['session_id', 'epoch', ...(key ? key.split(',') : [])]
    const sizes = [...columns, ...(payload ?? [])]
      .map((column) => `COALESCE(octet_length(${column}),0)`)
      .join('+')
    const remove = db.prepare(
      `DELETE FROM ${name} WHERE ${columns.map((column) => `${column}=?`).join(' AND ')}`
    )
    const rows = db
      .prepare(`SELECT ${columns.join(',')},${sizes} AS work_bytes FROM ${name}
      WHERE session_id=? ORDER BY ${columns.slice(1).join(',')} LIMIT ?`)
      .all(sessionId, 64 - deleted)
    for (const row of rows) {
      const size = Number(row.work_bytes)
      if (deleted && bytes + size > 1024 * 1024) {
        return { more: true, epoch: null }
      }
      deleted += Number(remove.run(...columns.map((column) => row[column])).changes)
      bytes += size
      if (deleted === 64 || bytes >= 1024 * 1024 || performance.now() - start >= 8) {
        return { more: true, epoch: null }
      }
    }
  }
  return { more: false, epoch: null }
}
