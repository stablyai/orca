import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import SyncDatabase from '../../../../sqlite/sync-database'
import { writeOpenCodeSqliteDatabase } from './session-scanner-opencode-sqlite-fixture'
import { listOpenCodeSqliteSessions } from './session-scanner-opencode-sqlite-list'

let root: string

afterEach(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true })
  }
})

function list(dbPath: string) {
  return listOpenCodeSqliteSessions({ dbPaths: [dbPath], limit: 10, issues: [] })
}

describe('listOpenCodeSqliteSessions', () => {
  it('lists legacy rows only until OpenCode reports its v1 migration complete', async () => {
    root = mkdtempSync(join(tmpdir(), 'orca-opencode-list-'))
    const dbPath = join(root, 'opencode.db')
    writeOpenCodeSqliteDatabase(dbPath, [
      { id: 'ses-a', title: 'A', turns: [{ role: 'user', parts: ['a'] }] }
    ])
    expect(await list(dbPath)).toHaveLength(1)

    const db = new SyncDatabase(dbPath)
    db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT)')
    db.prepare("INSERT INTO kv (key, value) VALUES ('migration.v1-v2', ?)").run(
      JSON.stringify({ phase: 'completed' })
    )
    db.close()

    // OpenCode 2.x reads session_v2; the legacy rows are stale duplicates.
    expect(await list(dbPath)).toHaveLength(0)
  })
})
