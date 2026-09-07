import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import { SCHEMA_VERSION } from './db/contract-constants'

describe('orchestration migration from every prior version stamp', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('opens and reopens a complete schema stamped at every prior version', () => {
    for (let version = 0; version < SCHEMA_VERSION; version += 1) {
      const dir = mkdtempSync(join(tmpdir(), `orca-migration-v${version}-`))
      tempDirs.push(dir)
      const dbPath = join(dir, 'orchestration.db')
      new OrchestrationDb(dbPath).close()

      const stamped = new Database(dbPath)
      stamped.pragma(`user_version = ${version}`)
      stamped.close()

      const migrated = new OrchestrationDb(dbPath)
      expect(migrated.db.pragma('user_version', { simple: true }), `v${version}`).toBe(
        SCHEMA_VERSION
      )
      migrated.close()

      const reopened = new OrchestrationDb(dbPath)
      expect(reopened.db.pragma('user_version', { simple: true }), `reopen v${version}`).toBe(
        SCHEMA_VERSION
      )
      expect(() => reopened.createTask({ spec: `migration v${version}` })).not.toThrow()
      reopened.close()
    }
  })
})
