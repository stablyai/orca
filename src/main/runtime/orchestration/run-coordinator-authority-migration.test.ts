import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import { SCHEMA_VERSION } from './db/contract-constants'
import { isCurrentRunCoordinator } from './run-coordinator-authority'

describe('Run coordinator authority migration', () => {
  let directory: string | undefined
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    if (directory) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('adds nullable authority identity to v30 Runs and backfills on same-pane use', () => {
    directory = mkdtempSync(join(tmpdir(), 'orca-run-authority-'))
    const dbPath = join(directory, 'orchestration.db')
    const initial = new OrchestrationDb(dbPath)
    const run = initial.createRun({
      objective: 'Retained v30 Run',
      coordinatorHandle: 'term_old',
      coordinatorPaneKey: 'tab_old:11111111-1111-4111-8111-111111111111'
    })
    initial.close()

    const oldDb = new Database(dbPath)
    oldDb.exec('DROP TRIGGER trg_runs_clear_stale_coordinator_authority')
    oldDb.exec('ALTER TABLE runs DROP COLUMN coordinator_process_incarnation')
    oldDb.exec('ALTER TABLE runs DROP COLUMN coordinator_host_scope')
    oldDb.exec('ALTER TABLE runs DROP COLUMN coordinator_authority_revision')
    oldDb.pragma('user_version = 30')
    oldDb.close()

    db = new OrchestrationDb(dbPath)
    expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    expect(db.getRun(run.id)).toMatchObject({
      coordinator_process_incarnation: null,
      coordinator_host_scope: null,
      coordinator_authority_revision: -1
    })
    const currentRun = db.createRun({
      objective: 'Created after v31 migration',
      coordinatorHandle: 'term_current',
      coordinatorPaneKey: 'tab_current:22222222-2222-4222-9222-222222222222',
      coordinatorProcessIncarnation: 'current:incarnation-1',
      coordinatorHostScope: JSON.stringify({ kind: 'local', hostId: 'local' })
    })
    expect(currentRun.coordinator_authority_revision).toBe(0)
    expect(
      isCurrentRunCoordinator(currentRun, {
        handle: 'term_current',
        paneKey: 'tab_current:22222222-2222-4222-9222-222222222222',
        processIncarnation: 'current:incarnation-1',
        hostScope: JSON.stringify({ kind: 'local', hostId: 'local' })
      })
    ).toBe(true)
    expect(
      isCurrentRunCoordinator(db.getRun(run.id)!, {
        handle: 'term_replacement',
        paneKey: 'tab_replacement:11111111-1111-4111-8111-111111111111',
        processIncarnation: 'replacement:incarnation-1',
        hostScope: JSON.stringify({ kind: 'local', hostId: 'local' })
      })
    ).toBe(false)
    expect(
      isCurrentRunCoordinator(db.getRun(run.id)!, {
        handle: 'term_old',
        paneKey: 'tab_replacement:11111111-1111-4111-8111-111111111111',
        processIncarnation: 'replacement:incarnation-1',
        hostScope: JSON.stringify({ kind: 'local', hostId: 'local' })
      })
    ).toBe(false)

    const rebound = db.bindRun({
      runId: run.id,
      coordinatorHandle: 'term_reminted',
      coordinatorPaneKey: 'tab_reminted:11111111-1111-4111-8111-111111111111',
      coordinatorProcessIncarnation: 'pty:incarnation-1',
      coordinatorHostScope: JSON.stringify({ kind: 'local', hostId: 'local' }),
      authorityContinuity: true
    })
    expect(rebound).toMatchObject({
      coordinator_handle: 'term_reminted',
      coordinator_process_incarnation: 'pty:incarnation-1',
      consumer_generation: run.consumer_generation
    })
  })

  it('clears stale authority when an older runtime changes only the binding columns', () => {
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'Mixed-version binding',
      coordinatorHandle: 'term_old',
      coordinatorPaneKey: 'tab_old:11111111-1111-4111-8111-111111111111',
      coordinatorProcessIncarnation: 'pty-old:incarnation-1',
      coordinatorHostScope: JSON.stringify({ kind: 'local', hostId: 'local' })
    })

    db.db
      .prepare(
        `UPDATE runs
         SET coordinator_handle = ?, coordinator_pane_key = ?,
             consumer_generation = consumer_generation + 1
         WHERE id = ?`
      )
      .run('term_v30', 'tab_v30:22222222-2222-4222-9222-222222222222', run.id)

    expect(db.getRun(run.id)).toMatchObject({
      coordinator_handle: 'term_v30',
      coordinator_process_incarnation: null,
      coordinator_host_scope: null,
      coordinator_authority_revision: -1
    })
  })
})
