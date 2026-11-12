import SyncDatabase from '../sync-database'
import { removeVersionedCacheDatabase } from '../versioned-cache-database'

import { classifyRowCacheFailure } from './row-cache-failure'

import type { KeyedJsonRow } from './keyed-json-row-cache'
export type StoredRow = { seq: number; json: string }

export const RECEIPT_KEY = 'legacy_import_receipt'

export function readRows(db: SyncDatabase): { stored: Map<string, StoredRow>; maxSeq: number } {
  const stored = new Map<string, StoredRow>()
  let maxSeq = 0
  for (const row of db.prepare('SELECT key, seq, value FROM rows ORDER BY seq').all()) {
    const { key, seq, value } = row
    if (typeof key === 'string' && typeof seq === 'number' && typeof value === 'string') {
      stored.set(key, { seq, json: value })
      maxSeq = Math.max(maxSeq, seq)
    }
  }
  return { stored, maxSeq }
}

export function readReceipt(db: SyncDatabase): unknown {
  return db.prepare('SELECT value FROM meta WHERE key = ?').get(RECEIPT_KEY)?.value
}

export function rollback(db: SyncDatabase): void {
  if (db.isTransaction) {
    db.exec('ROLLBACK')
  }
}

export function parseKeyedJsonRows(
  rows: readonly KeyedJsonRow[]
): { key: string; value: unknown }[] {
  return rows.flatMap(({ key, json }) => {
    try {
      const value: unknown = JSON.parse(json)
      return [{ key, value }]
    } catch {
      return []
    }
  })
}

export function parseOrNull<T>(parse: (text: string) => T | null, text: string): T | null {
  try {
    return parse(text)
  } catch {
    return null
  }
}

export function receiptNames(stored: unknown, receipt: string): boolean {
  if (typeof stored !== 'string') {
    return false
  }
  return stored === receipt || /^\d+:\d+:([0-9a-f]{64})$/.exec(stored)?.[1] === receipt
}

export function readKeyedJsonRowsSnapshot(
  path: string,
  schemaVersion: number,
  busyTimeoutMs: number
):
  | { kind: 'rows'; rows: KeyedJsonRow[]; receipt: unknown }
  | { kind: 'unavailable'; error: unknown } {
  let db: SyncDatabase | null = null
  try {
    db = new SyncDatabase(path, { readonly: true, fileMustExist: true })
    db.pragma(`busy_timeout = ${busyTimeoutMs}`)
    db.exec('BEGIN')
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('meta', 'rows')")
        .all()
      const version =
        tables.length === 2
          ? db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
          : undefined
      if (version?.value !== String(schemaVersion)) {
        // Another layout holds nothing this build reads; the first write rebuilds it.
        return { kind: 'rows', rows: [], receipt: undefined }
      }
      const rows = [...readRows(db).stored].map(([key, { json }]) => ({ key, json }))
      return { kind: 'rows', rows, receipt: readReceipt(db) }
    } finally {
      rollback(db)
    }
  } catch (error) {
    if (classifyRowCacheFailure(error) !== 'corrupt') {
      return { kind: 'unavailable', error }
    }
    db?.close()
    db = null
    try {
      // Damaged rows hold nothing recoverable; the next write rebuilds the cache.
      removeVersionedCacheDatabase(path, 'fail-fast')
    } catch (removeError) {
      return { kind: 'unavailable', error: removeError }
    }
    return { kind: 'rows', rows: [], receipt: undefined }
  } finally {
    db?.close()
  }
}
