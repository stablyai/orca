import type SyncDatabase from '../sync-database'
import type { StoredRow } from './keyed-json-row-plan'

export function readStoredRows(db: SyncDatabase): {
  stored: Map<string, StoredRow>
  maxSeq: number
} {
  const stored = new Map<string, StoredRow>()
  let maxSeq = 0
  // node:sqlite TEXT reads truncate embedded NULs in composite keys; BLOB preserves their bytes.
  for (const row of db
    .prepare('SELECT CAST(key AS BLOB) AS key, seq, value FROM rows ORDER BY seq')
    .all()) {
    const { seq, value } = row
    const key = row.key instanceof Uint8Array ? Buffer.from(row.key).toString('utf8') : row.key
    if (typeof key === 'string' && typeof seq === 'number' && typeof value === 'string') {
      stored.set(key, { seq, json: value })
      maxSeq = Math.max(maxSeq, seq)
    }
  }
  return { stored, maxSeq }
}
