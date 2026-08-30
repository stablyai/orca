import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import { SCHEMA_VERSION } from './db/contract-constants'
import { resolveOrchestrationMigrationStartVersion } from './orchestration-schema-version-skew'

describe('Run capacity migration (v31)', () => {
  let db: OrchestrationDb | undefined
  let tempDir: string | undefined

  afterEach(() => {
    db?.close()
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  function createV30Database(): { dbPath: string; runId: string; taskId: string } {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-run-capacity-migration-'))
    const dbPath = join(tempDir, 'orchestration.db')
    const current = new OrchestrationDb(dbPath)
    const run = current.createRun({
      objective: 'upgrade capacity defaults',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'repo:worktree:tab:leaf'
    })
    const task = current.createTask({ spec: 'pre-capacity task', runId: run.id })
    current.close()

    const oldDb = new Database(dbPath)
    oldDb.exec('DROP INDEX idx_tasks_capacity_ready')
    oldDb.exec('ALTER TABLE tasks DROP COLUMN capacity_eligible')
    oldDb.exec('ALTER TABLE runs DROP COLUMN target_concurrency')
    oldDb.pragma('user_version = 30')
    oldDb.close()
    return { dbPath, runId: run.id, taskId: task.id }
  }

  it('adds disabled targets and unenrolled Tasks when upgrading v30', () => {
    const { dbPath, runId, taskId } = createV30Database()
    db = new OrchestrationDb(dbPath)
    const sqlite = (db as unknown as { db: Database.Database }).db

    expect(sqlite.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    expect(db.getRun(runId)).toMatchObject({ target_concurrency: 0 })
    expect(db.getTask(taskId)).toMatchObject({ capacity_eligible: 0 })
    expect(db.getRunCapacity(runId)).toMatchObject({
      targetConcurrency: 0,
      activeCount: 0,
      availableSlots: 0,
      launchableCount: 0
    })
  })

  it('repairs a database that claims v31 without the v31 columns', () => {
    const { dbPath } = createV30Database()
    const malformed = new Database(dbPath)
    malformed.pragma('user_version = 31')

    expect(resolveOrchestrationMigrationStartVersion(malformed, 31, SCHEMA_VERSION)).toBe(6)
    malformed.close()

    db = new OrchestrationDb(dbPath)
    expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
  })

  it('repairs a database that claims v31 without the capacity-ready index', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-run-capacity-index-repair-'))
    const dbPath = join(tempDir, 'orchestration.db')
    db = new OrchestrationDb(dbPath)
    db.close()
    db = undefined

    const malformed = new Database(dbPath)
    malformed.exec('DROP INDEX idx_tasks_capacity_ready')
    expect(resolveOrchestrationMigrationStartVersion(malformed, 31, SCHEMA_VERSION)).toBe(6)
    malformed.close()

    db = new OrchestrationDb(dbPath)
    expect(
      db.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get('idx_tasks_capacity_ready')
    ).toBeDefined()
  })
})
