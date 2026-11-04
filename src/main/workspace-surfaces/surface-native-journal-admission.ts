import { statSync } from 'node:fs'
import Database from '../sqlite/sync-database'
import {
  JOURNAL_DB_SCHEMA_VERSION,
  JOURNAL_DB_OLDEST_RELEASED_VERSION
} from '../native-chat/agent-session-journal/journal-database-schema'

/** Probe without creating or changing the file; the native lane has already drained its owners. */
export function admitSurfaceNativeJournal(db: Database.Database, filename: string): void {
  const target = statSync(filename)
  if (!target.isFile()) {
    throw new Error('Joint surface transaction requires an existing native journal')
  }
  for (const row of db.prepare('PRAGMA database_list').all()) {
    if (row.name === 'surface_chat') {
      throw new Error('Joint surface transaction already has an attached native journal')
    }
    if (typeof row.file !== 'string' || !row.file) {
      continue
    }
    const attached = statSync(row.file)
    if (attached.dev === target.dev && attached.ino === target.ino) {
      throw new Error('Joint surface transaction requires a separate native journal')
    }
  }
  const probe = new Database(filename, { readonly: true, fileMustExist: true })
  try {
    const version = probe.pragma('user_version', { simple: true })
    if (
      typeof version !== 'number' ||
      version < JOURNAL_DB_OLDEST_RELEASED_VERSION ||
      version > JOURNAL_DB_SCHEMA_VERSION
    ) {
      throw new Error('Native journal cannot accept surface membership')
    }
  } finally {
    probe.close()
  }
}
