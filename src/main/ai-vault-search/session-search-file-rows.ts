import type SyncDatabase from '../sqlite/sync-database'
import type { SessionSearchFileRow } from './session-search-store-types'

export function readSessionSearchFileRows(db: SyncDatabase, path?: string): SessionSearchFileRow[] {
  const statement = db.prepare(
    // Numeric stat IDs may exceed SQLite's safe INTEGER-to-number read range.
    `SELECT f.path, f.byte_offset AS byteOffset, f.prefix_hash AS prefixHash, s.agent, CAST(f.dev AS REAL) AS dev, CAST(f.ino AS REAL) AS ino,
                  mtime_ms AS mtimeMs, size_bytes AS sizeBytes,
                  state, fail_count AS failCount, failed_mtime_ms AS failedMtimeMs
           FROM files f LEFT JOIN sessions s ON s.id=f.session_row_id${path === undefined ? '' : ' WHERE f.path = ?'}`
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this query explicitly selects the file-row fields and nullable numeric identity columns.
  const rows = statement.all(...(path === undefined ? [] : [path])) as (Omit<
    SessionSearchFileRow,
    'identity'
  > & {
    dev: number | null
    ino: number | null
  })[]
  return rows.map((row) => ({
    path: row.path,
    byteOffset: row.byteOffset,
    prefixHash: row.prefixHash,
    agent: row.agent,
    identity:
      typeof row.dev === 'number' && typeof row.ino === 'number'
        ? { dev: row.dev, ino: row.ino }
        : null,
    mtimeMs: row.mtimeMs,
    sizeBytes: row.sizeBytes,
    state: row.state,
    failCount: row.failCount,
    failedMtimeMs: row.failedMtimeMs
  }))
}
