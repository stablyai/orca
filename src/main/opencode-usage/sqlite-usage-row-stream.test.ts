import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import { UsageHistoryScanBudget, UsageHistoryScanCapacityError } from '../usage-history-scan-budget'
import { parseOpenCodeUsageDatabase } from './scanner'
import {
  iterateOpenCodeUsageRows,
  OPENCODE_USAGE_SQLITE_ROW_MAX_BYTES
} from './sqlite-usage-row-stream'

const tempDirs: string[] = []

function createDatabase(): { db: Database.Database; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orca-opencode-retention-'))
  tempDirs.push(dir)
  const path = join(dir, 'opencode.db')
  const db = new Database(path)
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      directory TEXT,
      title TEXT,
      cost REAL,
      tokens_input INTEGER,
      tokens_output INTEGER,
      tokens_reasoning INTEGER,
      tokens_cache_read INTEGER,
      time_created INTEGER,
      time_updated INTEGER
    );
  `)
  return { db, path }
}

function insertSession(db: Database.Database, id: string, title = '', inputTokens = 1): void {
  db.prepare(
    `INSERT INTO session (
      id, directory, title, cost,
      tokens_input, tokens_output, tokens_reasoning, tokens_cache_read,
      time_created, time_updated
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, null, title, 0, inputTokens, 0, 0, 0, 1_777_777_700_000, 1_777_777_800_000)
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('OpenCode SQLite usage row retention', () => {
  it('preserves an exact-boundary row', () => {
    const { db } = createDatabase()
    const title = 't'.repeat(OPENCODE_USAGE_SQLITE_ROW_MAX_BYTES - 2)
    insertSession(db, 's', title)

    const rows = [...iterateOpenCodeUsageRows(db)]

    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe('s')
    expect(rows[0]?.title).toBe(title)
    db.close()
  })

  it('rejects a row one byte above the retained-text limit', () => {
    const { db } = createDatabase()
    insertSession(db, 's', 't'.repeat(OPENCODE_USAGE_SQLITE_ROW_MAX_BYTES - 1))

    expect(() => [...iterateOpenCodeUsageRows(db)]).toThrowError(
      new UsageHistoryScanCapacityError('retainedBytes', OPENCODE_USAGE_SQLITE_ROW_MAX_BYTES)
    )
    db.close()
  })

  it('rejects oversized legacy JSON before asking SQLite to parse it', () => {
    const { db } = createDatabase()
    insertSession(db, 's', '', 0)
    db.exec(`
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        time_created INTEGER,
        time_updated INTEGER,
        data TEXT
      );
    `)
    const data = `{"role":"assistant","padding":"${'x'.repeat(
      OPENCODE_USAGE_SQLITE_ROW_MAX_BYTES
    )}"}`
    db.prepare(
      'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)'
    ).run('m', 's', 1, 1, data)

    expect(() => [...iterateOpenCodeUsageRows(db)]).toThrowError(
      new UsageHistoryScanCapacityError('retainedBytes', OPENCODE_USAGE_SQLITE_ROW_MAX_BYTES)
    )
    db.close()
  })

  it('shares the history record budget across streamed rows', async () => {
    const { db, path } = createDatabase()
    insertSession(db, 'session-1')
    insertSession(db, 'session-2')
    db.close()
    const budget = new UsageHistoryScanBudget({
      records: 1,
      ownershipKeys: 4,
      retainedBytes: 16 * 1024 * 1024
    })

    await expect(parseOpenCodeUsageDatabase(path, [], { budget })).rejects.toMatchObject({
      resource: 'records',
      limit: 1
    })
  })
})
