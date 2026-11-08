import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import SyncDatabase from '../../../../sqlite/sync-database'
import { lastStatusDatabasePath } from '../../last-status-store'
import { LAST_STATUS_FILE_VERSION } from '../../server-constants'

/** What a restart restores, in the last-status file shape, read straight from the saved rows. */
export function readSavedStatus(lastStatusPath: string): string {
  const path = lastStatusDatabasePath(lastStatusPath)
  const db = new SyncDatabase(path, { readonly: true, fileMustExist: true })
  try {
    const entries: Record<string, unknown> = {}
    const authorityCommitments: Record<string, unknown> = {}
    const file: {
      version: number
      entries: typeof entries
      authorityCommitments: typeof authorityCommitments
      agentExits?: unknown
    } = {
      version: LAST_STATUS_FILE_VERSION,
      entries,
      authorityCommitments
    }
    for (const row of db.prepare('SELECT kind, key, payload FROM rows').all()) {
      const value: unknown = JSON.parse(String(row.payload))
      if (row.kind === 'entry') {
        entries[String(row.key)] = value
      } else if (row.kind === 'commitment') {
        authorityCommitments[String(row.key)] = value
      } else {
        file.agentExits = value
      }
    }
    return JSON.stringify(file)
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
