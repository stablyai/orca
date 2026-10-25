import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import { reconcileSettledWorkerDispatches } from './db/worker-dispatch/worker-dispatch-settlement'

const dispatchStates = ['pending', 'dispatched', 'completed', 'failed', 'circuit_broken'] as const
const workerStates = [
  'starting',
  'ready',
  'start_unknown',
  'stopping',
  'stop_unknown',
  'succeeded',
  'failed',
  'stopped',
  'abandoned'
] as const

describe('historical worker repair safety', () => {
  let directory: string
  let databasePath: string
  let db: OrchestrationDb
  let runId: string
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-worker-repair-safety-'))
    databasePath = join(directory, 'orchestration.db')
    db = new OrchestrationDb(databasePath)
    runId = db.createRun({
      objective: 'repair safety',
      coordinatorHandle: null,
      coordinatorPaneKey: null
    }).id
  })
  afterEach(() => {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  })

  function historicalWorker(dispatchState: (typeof dispatchStates)[number], state: string) {
    const task = db.createTask({ runId, spec: 'historical worker repair' })
    const { dispatch } = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: dispatch.id,
      handle: `term_${dispatch.id}`,
      paneKey: `tab_${dispatch.id}:leaf`,
      processIncarnation: 'pty-live:22222222-2222-4222-8222-222222222222',
      worktreeId: 'folder-workspace',
      setupState: 'not_applicable',
      effects: [],
      terminalOwnership: 'created'
    })
    db.db
      .prepare('UPDATE dispatch_contexts SET status = ? WHERE id = ?')
      .run(dispatchState, dispatch.id)
    db.db
      .prepare('UPDATE worker_dispatches SET state = ?, last_error = ? WHERE dispatch_id = ?')
      .run(state, 'retain this diagnostic', dispatch.id)
    return {
      id: dispatch.id,
      task: db.getTask(task.id),
      dispatch: db.getDispatchContextById(dispatch.id),
      worker: db.getWorkerDispatch(dispatch.id),
      resource: db.getWorkerTerminalResourceByOwner(dispatch.id),
      shouldSettle:
        ['completed', 'failed', 'circuit_broken'].includes(dispatchState) &&
        ['starting', 'ready', 'start_unknown', 'stopping', 'stop_unknown'].includes(state)
    }
  }

  it('repairs only settled assignments across all 45 state combinations and is idempotent', () => {
    const before = dispatchStates.flatMap((dispatchState) =>
      workerStates.map((state) => historicalWorker(dispatchState, state))
    )
    db.close()
    db = new OrchestrationDb(databasePath)
    for (const row of before) {
      expect(db.getWorkerDispatch(row.id)).toEqual({
        ...row.worker,
        ...(row.shouldSettle
          ? { state: 'abandoned', stage: 'assignment_settled', updated_at: expect.any(String) }
          : {})
      })
      expect(db.getDispatchContextById(row.id)).toEqual(row.dispatch)
      expect(db.getTask(row.task!.id)).toEqual(row.task)
      expect(db.getWorkerTerminalResourceByOwner(row.id)).toEqual(row.resource)
    }
    db.db.exec(`CREATE TRIGGER reject_repeated_worker_repair BEFORE UPDATE ON worker_dispatches
      BEGIN SELECT RAISE(ABORT, 'worker changed on second open'); END;`)
    db.close()
    db = new OrchestrationDb(databasePath)
    const changesBefore = db.db.prepare('SELECT total_changes() AS changes').get()
    reconcileSettledWorkerDispatches(db.db)
    expect(db.db.prepare('SELECT total_changes() AS changes').get()).toEqual(changesBefore)
    expect(db.listLegacyWorkerTerminalRecoveryRows()).toHaveLength(10)
  })

  it('rolls back earlier repairs when a later historical worker cannot be settled', () => {
    const before = [historicalWorker('completed', 'ready'), historicalWorker('failed', 'ready')]
    db.db.exec(`
      CREATE TABLE repair_events (dispatch_id TEXT);
      CREATE TRIGGER count_worker_repair AFTER UPDATE ON worker_dispatches
        BEGIN INSERT INTO repair_events VALUES (NEW.dispatch_id); END;
      CREATE TRIGGER reject_second_repair BEFORE UPDATE ON worker_dispatches
        WHEN (SELECT COUNT(*) FROM repair_events) = 1
        BEGIN SELECT RAISE(ABORT, 'second historical repair failed'); END;
    `)
    expect(() => reconcileSettledWorkerDispatches(db.db)).toThrow('second historical repair failed')
    expect(db.db.prepare('SELECT dispatch_id FROM repair_events').all()).toEqual([])
    for (const row of before) {
      expect(db.getWorkerDispatch(row.id)).toEqual(row.worker)
      expect(db.getDispatchContextById(row.id)).toEqual(row.dispatch)
      expect(db.getWorkerTerminalResourceByOwner(row.id)).toEqual(row.resource)
    }
    expect(db.db.isTransaction).toBe(false)
  })

  it('does not take a writer lock for a healthy database while another writer is active', () => {
    historicalWorker('completed', 'succeeded')
    const writer = new Database(databasePath)
    db.db.pragma('busy_timeout = 0')
    writer.exec('BEGIN IMMEDIATE')
    const exec = vi.spyOn(db.db, 'exec')
    try {
      expect(() => reconcileSettledWorkerDispatches(db.db)).not.toThrow()
      expect(exec).not.toHaveBeenCalled()
    } finally {
      exec.mockRestore()
      writer.exec('ROLLBACK')
      writer.close()
    }
  })

  it('repairs stale bookkeeping reintroduced by an older writer after an earlier repair', () => {
    const worker = historicalWorker('completed', 'ready')
    reconcileSettledWorkerDispatches(db.db)
    expect(db.getWorkerDispatch(worker.id)?.state).toBe('abandoned')

    const olderWriter = new Database(databasePath)
    try {
      olderWriter
        .prepare("UPDATE worker_dispatches SET state = 'ready' WHERE dispatch_id = ?")
        .run(worker.id)
    } finally {
      olderWriter.close()
    }
    db.close()
    db = new OrchestrationDb(databasePath)
    expect(db.getWorkerDispatch(worker.id)?.state).toBe('abandoned')
    expect(db.getWorkerTerminalResourceByOwner(worker.id)).toEqual(worker.resource)
  })

  it('measures repair and no-op reopen with 100,000 historical assignments', () => {
    const task = db.createTask({ runId, spec: 'large repair history' })
    const insertDispatch = db.db.prepare(
      'INSERT INTO dispatch_contexts (id, task_id, run_id, status) VALUES (?, ?, ?, ?)'
    )
    const insertWorker = db.db.prepare(
      'INSERT INTO worker_dispatches (dispatch_id, state) VALUES (?, ?)'
    )
    db.db.exec('BEGIN IMMEDIATE')
    try {
      for (let index = 0; index < 100_000; index += 1) {
        const id = `historical-${index}`
        insertDispatch.run(id, task.id, runId, 'completed')
        insertWorker.run(id, index < 1_000 ? 'ready' : 'succeeded')
      }
      db.db.exec('COMMIT')
    } catch (error) {
      db.db.exec('ROLLBACK')
      throw error
    }
    const prepare = vi.spyOn(db.db, 'prepare')
    const repairStart = performance.now()
    reconcileSettledWorkerDispatches(db.db)
    const repairMs = performance.now() - repairStart
    const repairSql = prepare.mock.calls.find(([sql]) => sql.includes('SELECT wd.dispatch_id'))?.[0]
    prepare.mockRestore()
    expect(repairSql).toBeDefined()
    const queryPlan = db.db.prepare(`EXPLAIN QUERY PLAN ${repairSql}`).all()
    expect(queryPlan).toContainEqual(
      expect.objectContaining({
        detail: expect.stringContaining('idx_worker_dispatches_recoverable')
      })
    )
    expect(queryPlan).toContainEqual(
      expect.objectContaining({ detail: expect.stringMatching(/^SEARCH dc.*\(id=\?\)$/) })
    )
    expect(
      db.db
        .prepare("SELECT COUNT(*) AS count FROM worker_dispatches WHERE state = 'abandoned'")
        .get()
    ).toEqual({ count: 1_000 })
    const changesBefore = db.db.prepare('SELECT total_changes() AS changes').get()
    const noOpStart = performance.now()
    reconcileSettledWorkerDispatches(db.db)
    const noOpMs = performance.now() - noOpStart
    expect(db.db.prepare('SELECT total_changes() AS changes').get()).toEqual(changesBefore)
    db.close()
    const reopenStart = performance.now()
    db = new OrchestrationDb(databasePath)
    const reopenMs = performance.now() - reopenStart
    db.db.exec('DROP INDEX idx_worker_dispatches_recoverable')
    db.db.exec("UPDATE worker_dispatches SET state = 'ready' WHERE state = 'abandoned'")
    db.close()
    const upgradeStart = performance.now()
    db = new OrchestrationDb(databasePath)
    const indexBuildOpenMs = performance.now() - upgradeStart
    expect(db.db.prepare(`EXPLAIN QUERY PLAN ${repairSql}`).all()).toEqual(queryPlan)
    expect(
      db.db
        .prepare("SELECT COUNT(*) AS count FROM worker_dispatches WHERE state = 'abandoned'")
        .get()
    ).toEqual({ count: 1_000 })
    process.stdout.write(
      `${JSON.stringify({ assignments: 100_000, repairMs, noOpMs, reopenMs, indexBuildOpenMs })}\n`
    )
  })
})
