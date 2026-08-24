import Database from '../../sqlite/sync-database'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OrchestrationDb } from './db'
import { SCHEMA_VERSION } from './db/contract-constants'

describe('parent-loss checkpoint schema migration', () => {
  let directory: string | undefined
  afterEach(() => {
    if (directory) {
      rmSync(directory, { recursive: true, force: true })
      directory = undefined
    }
  })

  it('adds v30 checkpoint storage to an existing v29 database', () => {
    directory = mkdtempSync(join(tmpdir(), 'orca-parent-loss-migration-'))
    const path = join(directory, 'orchestration.db')
    const initial = new OrchestrationDb(path)
    initial.close()
    const raw = new Database(path)
    raw.exec('DROP TABLE parent_loss_checkpoints')
    raw.pragma('user_version = 29')
    raw.close()

    const migrated = new OrchestrationDb(path)
    try {
      expect(migrated.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
      const table = migrated.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get('parent_loss_checkpoints')
      expect(table).toBeTruthy()
      const columns = migrated.db.prepare('PRAGMA table_info(parent_loss_checkpoints)').all() as {
        name: string
      }[]
      expect(columns.map((column) => column.name)).toContain('correlation_id')
    } finally {
      migrated.close()
    }
  })
})
