import type Database from './sync-database'

export type SurfaceTransactionSchema = 'main' | 'surface_chat'

/** Caller drains other owners/readers before conversion; SQLite alone recovers and removes sidecars. */
export function configureSqliteRollbackDurability(
  db: Database.Database,
  schema: SurfaceTransactionSchema,
  busyTimeoutMs: number
): void {
  if (db.isTransaction) {
    throw new Error('SQLite durability conversion requires an idle owner')
  }
  db.pragma(`busy_timeout = ${busyTimeoutMs}`)
  const previousMode = db.pragma(`${schema}.journal_mode`, { simple: true })
  if (previousMode === 'wal') {
    const checkpoint = db.pragma(`${schema}.wal_checkpoint(TRUNCATE)`)
    if (
      !Array.isArray(checkpoint) ||
      checkpoint.length !== 1 ||
      checkpoint.some(
        (row: unknown) =>
          row === null || typeof row !== 'object' || !('busy' in row) || row.busy !== 0
      )
    ) {
      throw new Error('SQLite WAL conversion requires drained readers and writers')
    }
  }
  const mode =
    previousMode === 'delete'
      ? previousMode
      : db.pragma(`${schema}.journal_mode = DELETE`, { simple: true })
  if (mode !== 'delete') {
    throw new Error(`SQLite storage cannot use rollback journaling (mode: ${String(mode)})`)
  }
  db.pragma(`${schema}.locking_mode = NORMAL`)
  db.pragma(`${schema}.synchronous = FULL`)
  db.pragma('fullfsync = ON')
  if (
    db.pragma(`${schema}.synchronous`, { simple: true }) !== 2 ||
    db.pragma(`${schema}.locking_mode`, { simple: true }) !== 'normal' ||
    db.pragma('fullfsync', { simple: true }) !== 1
  ) {
    throw new Error('SQLite rollback durability could not be verified')
  }
}
