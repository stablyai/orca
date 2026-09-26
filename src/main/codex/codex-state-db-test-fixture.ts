import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import SyncDatabase from '../sqlite/sync-database'

/** Writes a Codex state DB whose startup backfill reports `status`. */
export function writeCodexStateDbBackfillStatus(codexHomePath: string, status: string): void {
  mkdirSync(codexHomePath, { recursive: true })
  const db = new SyncDatabase(join(codexHomePath, 'state_5.sqlite'))
  db.exec(
    'CREATE TABLE backfill_state (id INTEGER PRIMARY KEY, status TEXT NOT NULL); ' +
      `INSERT INTO backfill_state (id, status) VALUES (1, '${status}')`
  )
  db.close()
}
