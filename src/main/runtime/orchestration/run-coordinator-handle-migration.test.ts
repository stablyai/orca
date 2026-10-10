import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import { SCHEMA_VERSION } from './db/contract-constants'

describe('Run coordinator handle history migration', () => {
  let db: OrchestrationDb | undefined
  let tempDir: string | undefined

  afterEach(() => {
    db?.close()
    db = undefined
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = undefined
    }
  })

  it('preserves v27 coordinator authority for mail arriving after a rebind', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-run-coordinator-handle-migration-'))
    const dbPath = join(tempDir, 'orchestration.db')
    db = new OrchestrationDb(dbPath)
    const run = db.createRun({
      objective: 'migration authority',
      coordinatorHandle: 'term_old',
      coordinatorPaneKey: 'tab:leaf'
    })
    db.close()
    db = undefined

    const oldDb = new Database(dbPath)
    oldDb.exec('DROP TABLE run_coordinator_handles')
    oldDb.pragma('user_version = 27')
    oldDb.close()

    db = new OrchestrationDb(dbPath)
    const sqlite = (db as unknown as { db: Database.Database }).db
    expect(sqlite.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    expect(
      sqlite
        .prepare('SELECT run_id, terminal_handle FROM run_coordinator_handles WHERE run_id = ?')
        .all(run.id)
    ).toEqual([{ run_id: run.id, terminal_handle: 'term_old' }])

    db.bindRun({
      runId: run.id,
      coordinatorHandle: 'term_new',
      coordinatorPaneKey: 'tab:leaf'
    })
    const late = db.insertMessage({
      runId: run.id,
      from: 'worker',
      to: 'term_old',
      subject: 'late completion',
      type: 'worker_done'
    })
    sqlite.prepare('UPDATE messages SET to_handle = ? WHERE id = ?').run('term_old', late.id)

    expect(db.routeForeignDirectMessagesToOwnedMailboxes('term_old')).toMatchObject({
      routedCount: 1,
      mailboxes: [{ mailboxHandle: `run:${run.id}`, types: ['worker_done'] }]
    })
    expect(db.getMessageById(late.id)?.to_handle).toBe(`run:${run.id}`)
  })

  it('self-converges a v28 database created before coordinator history existed', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-run-coordinator-v28-convergence-'))
    const dbPath = join(tempDir, 'orchestration.db')
    db = new OrchestrationDb(dbPath)
    const run = db.createRun({
      objective: 'schema collision',
      coordinatorHandle: 'term_existing',
      coordinatorPaneKey: 'tab:leaf'
    })
    db.close()
    db = undefined

    const v28Db = new Database(dbPath)
    v28Db.exec('DROP TABLE run_coordinator_handles')
    expect(v28Db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    v28Db.close()

    db = new OrchestrationDb(dbPath)
    const sqlite = (db as unknown as { db: Database.Database }).db
    expect(sqlite.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    expect(
      sqlite
        .prepare('SELECT run_id, terminal_handle FROM run_coordinator_handles WHERE run_id = ?')
        .all(run.id)
    ).toEqual([{ run_id: run.id, terminal_handle: 'term_existing' }])
  })

  it('records every coordinator rebind performed by an older runtime', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-run-coordinator-old-runtime-'))
    const dbPath = join(tempDir, 'orchestration.db')
    db = new OrchestrationDb(dbPath)
    const run = db.createRun({
      objective: 'mixed-version authority',
      coordinatorHandle: 'term_v28',
      coordinatorPaneKey: 'tab:leaf'
    })
    db.close()
    db = undefined

    const oldRuntimeDb = new Database(dbPath)
    oldRuntimeDb
      .prepare('UPDATE runs SET coordinator_handle = ? WHERE id = ?')
      .run('term_v27_first', run.id)
    oldRuntimeDb
      .prepare('UPDATE runs SET coordinator_handle = ? WHERE id = ?')
      .run('term_v27_second', run.id)
    expect(oldRuntimeDb.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    oldRuntimeDb.close()

    db = new OrchestrationDb(dbPath)
    const sqlite = (db as unknown as { db: Database.Database }).db
    expect(
      sqlite
        .prepare(
          'SELECT terminal_handle FROM run_coordinator_handles WHERE run_id = ? ORDER BY terminal_handle'
        )
        .all(run.id)
    ).toEqual([
      { terminal_handle: 'term_v27_first' },
      { terminal_handle: 'term_v27_second' },
      { terminal_handle: 'term_v28' }
    ])
    const late = db.insertMessage({
      runId: run.id,
      from: 'worker',
      to: 'term_v27_first',
      subject: 'late intermediate completion',
      type: 'worker_done'
    })
    expect(db.getMessageById(late.id)?.to_handle).toBe(`run:${run.id}`)
  })

  it('reinstalls coordinator routing after a migration removes the trigger', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-run-coordinator-trigger-migration-'))
    const dbPath = join(tempDir, 'orchestration.db')
    db = new OrchestrationDb(dbPath)
    const run = db.createRun({
      objective: 'trigger migration',
      coordinatorHandle: 'term_migrated',
      coordinatorPaneKey: 'tab:leaf'
    })
    db.close()
    db = undefined

    const oldDb = new Database(dbPath)
    oldDb.exec('DROP TRIGGER trg_messages_route_coordinator_mail')
    oldDb.pragma('user_version = 27')
    oldDb.close()

    db = new OrchestrationDb(dbPath)
    const message = db.insertMessage({
      runId: run.id,
      from: 'worker',
      to: 'term_migrated',
      subject: 'first post-migration message'
    })

    expect(db.getMessageById(message.id)?.to_handle).toBe(`run:${run.id}`)
  })
})
