import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import SyncDatabase from '../../../../sqlite/sync-database'
import { lastStatusDatabasePath } from '../../last-status-store'
import { assemble } from '../../last-status-saved-rows'

/** What a restart restores, in the last-status file shape, read straight from the saved rows. */
export function readSavedStatus(lastStatusPath: string): string {
  const db = new SyncDatabase(lastStatusDatabasePath(lastStatusPath), {
    readonly: true,
    fileMustExist: true
  })
  try {
    const rows = db
      .prepare('SELECT key, value FROM rows ORDER BY seq')
      .all()
      .map((row) => ({ key: String(row.key), json: String(row.value) }))
    const { agentExits, ...file } = assemble(rows)
    return JSON.stringify(agentExits.length > 0 ? { ...file, agentExits } : file)
  } finally {
    db.close()
  }
}

export function hasSavedStatus(lastStatusPath: string): boolean {
  if (!existsSync(lastStatusDatabasePath(lastStatusPath))) {
    return false
  }
  return Object.keys(JSON.parse(readSavedStatus(lastStatusPath)).entries).length > 0
}

/** Another connection holding the write lock, as a second process would. */
export function holdSavedStatusLock(lastStatusPath: string): () => void {
  mkdirSync(dirname(lastStatusPath), { recursive: true })
  const db = new SyncDatabase(lastStatusDatabasePath(lastStatusPath))
  db.exec('BEGIN EXCLUSIVE')
  return () => {
    db.exec('ROLLBACK')
    db.close()
  }
}
