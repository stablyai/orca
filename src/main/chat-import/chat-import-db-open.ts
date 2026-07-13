import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import SyncDatabase from '../sqlite/sync-database'
import { initChatImportSchema } from './chat-import-schema'

// Why: the native host is a short-lived writer that may run while Orca reads
// the same DB. WAL lets a reader and the writer coexist; busy_timeout absorbs
// the brief lock windows. Runs outside Electron, so it creates the dir itself.
export function openChatImportDbForWrite(dbPath: string): SyncDatabase {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new SyncDatabase(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  initChatImportSchema(db)
  return db
}
