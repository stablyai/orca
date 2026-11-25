import type Database from '../../sqlite/sync-database'
import { isReadableAgentSessionStoreOperation } from '../../runtime/agent-session/records/agent-session-store-row-rules'

/** Unknown schemas remain saved without hiding readable expired rows behind them. */
export function pruneJournalWriterOperations(db: Database.Database, now: number): string[] {
  const keys: string[] = []
  let after: { expiresAt: number; key: string } | undefined
  while (keys.length < 128) {
    const rows = db
      .prepare(`SELECT operation_key,row_json,expires_at FROM agent_session_operations
      WHERE expires_at<=? ${after ? 'AND (expires_at,operation_key)>(?,?)' : ''}
      ORDER BY expires_at,operation_key LIMIT 128`)
      .all(now, ...(after ? [after.expiresAt, after.key] : []))
    for (const row of rows) {
      const key = String(row.operation_key)
      after = { expiresAt: Number(row.expires_at), key }
      if (isReadableAgentSessionStoreOperation(key, JSON.parse(String(row.row_json)))) {
        keys.push(key)
        if (keys.length === 128) {
          break
        }
      }
    }
    if (rows.length < 128) {
      break
    }
  }
  if (keys.length) {
    db.prepare(`DELETE FROM agent_session_operations
      WHERE operation_key IN (SELECT value FROM json_each(?))`).run(JSON.stringify(keys))
  }
  return keys
}
