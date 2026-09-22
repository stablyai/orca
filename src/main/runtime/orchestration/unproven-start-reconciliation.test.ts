import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { WORKER_UNPROVEN_LIFECYCLE_RECONCILE_AFTER_MS } from '../../../shared/orchestration-timing-budgets'
import { projectWorkerFleet } from '../rpc/methods/orchestration/worker/worker-list-projection'
import { OrchestrationDb } from './db'

type WorkerFixture = {
  dispatchId: string
  capability: string
  paneKey: string
  incarnation: string
}

let db: OrchestrationDb | undefined
let dir: string | undefined

afterEach(() => {
  db?.close()
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
  }
  db = undefined
  dir = undefined
})

describe('reconciling a Dispatch whose start was never observed', () => {
  // The exact Postulable row, read back through the real listing query and projection.
  it('projects a reconciliation instead of stranding the coordinator', () => {
    const database = createDatabase()
    const task = database.createTask({ runId: createRunId(database), spec: 'postulable repro' })
    const worker = startUnknownWorker(database, task.id, 'wedged')
    ageUnprovenState(database, worker.dispatchId)

    const row = projectDispatch(database, worker.dispatchId)

    expect(row.stage.worker).toBe('start_unknown')
    // `worker-list --include-remote` reported this Dispatch as active/pending.
    expect(['pending', 'dispatched']).toContain(row.stage.dispatch)
    expect(row.liveness.verdict).toBe('unverifiable')
    expect(row.attention.requiresAction).toBe(true)
    expect(row.nextAction).toEqual({
      kind: 'reconcile',
      argv: ['orchestration', 'worker-abandon', '--dispatch', worker.dispatchId]
    })
  })

  // C — the offer is only an offer. A worker that was alive all along still wins.
  it('keeps a late worker_done authoritative over an outstanding reconciliation', () => {
    const database = createDatabase()
    const task = database.createTask({ runId: createRunId(database), spec: 'late report' })
    const worker = startUnknownWorker(database, task.id, 'late')
    ageUnprovenState(database, worker.dispatchId)
    expect(projectDispatch(database, worker.dispatchId).nextAction.kind).toBe('reconcile')

    expect(
      database.settleWorkerReport({
        taskId: task.id,
        dispatchId: worker.dispatchId,
        outcome: 'succeeded',
        result: 'the turn had started after all'
      })
    ).toEqual({ action: 'settled', outcome: 'succeeded', duplicate: false })

    expect(database.getWorkerDispatch(worker.dispatchId)?.state).toBe('succeeded')
    expect(database.getDispatchContextById(worker.dispatchId)?.status).toBe('completed')
    expect(projectDispatch(database, worker.dispatchId).nextAction.kind).not.toBe('reconcile')
  })

  // G — ownership is genuinely unresolved until the coordinator settles it, so nothing else may.
  it('keeps the Task unsettled and the capability valid while ownership is unresolved', () => {
    const database = createDatabase()
    const task = database.createTask({ runId: createRunId(database), spec: 'contested' })
    const held = startUnknownWorker(database, task.id, 'held')
    ageUnprovenState(database, held.dispatchId)

    expect(database.getDispatchContext(task.id)?.id).toBe(held.dispatchId)
    expect(database.getTask(task.id)?.status).not.toBe('completed')
    expectCapability(database, held, true)
  })

  // E + atomic reconciliation — ownership is terminal before a replacement is legal.
  it('revokes ownership atomically so a replacement never races the old Dispatch', () => {
    const database = createDatabase()
    const task = database.createTask({ runId: createRunId(database), spec: 'replaced' })
    const stranded = startUnknownWorker(database, task.id, 'stranded')
    ageUnprovenState(database, stranded.dispatchId)

    const abandoned = database.abandonWorkerDispatch(stranded.dispatchId)

    expect(abandoned.disposition).toBe('abandoned')
    expect(database.getWorkerDispatch(stranded.dispatchId)?.state).toBe('abandoned')
    expect(database.getDispatchContextById(stranded.dispatchId)?.status).toBe('failed')
    // The old capability is dead before anything replaces it, so two workers cannot both act.
    expectCapability(database, stranded, false)

    sqliteFor(database).prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(task.id)
    const replacement = startUnknownWorker(database, task.id, 'replacement')

    expect(database.getDispatchContext(task.id)?.id).toBe(replacement.dispatchId)
    expect(activeDispatchIds(database, task.id)).toEqual([replacement.dispatchId])
  })

  // F — the one-time recovery stays one-time: the transition only exists out of `starting`.
  it('refuses to re-enter the unproven-start state a second time', () => {
    const database = createDatabase()
    const task = database.createTask({ runId: createRunId(database), spec: 'one shot' })
    const worker = startUnknownWorker(database, task.id, 'once')

    expect(() =>
      database.markWorkerStartUnknown(worker.dispatchId, 'turn_start_unobserved', 'again')
    ).toThrow(/not starting/)
    expect(database.getWorkerDispatch(worker.dispatchId)?.state).toBe('start_unknown')
  })
})

function createDatabase(): OrchestrationDb {
  dir = mkdtempSync(join(tmpdir(), 'orca-unproven-start-'))
  db = new OrchestrationDb(join(dir, 'orchestration.db'))
  return db
}

/** One Run with a bound coordinator, so Tasks in these cases have somewhere to live. */
function createRunId(database: OrchestrationDb): string {
  return database.createRun({
    objective: 'unproven start reconciliation',
    coordinatorHandle: 'term_coordinator',
    coordinatorPaneKey: 'tab_coordinator:aaaaaaaa-aaaa-4aaa-8aaa-000000000000'
  }).id
}

/** A worker whose prompt was accepted and whose turn start was never observed. */
function startUnknownWorker(
  database: OrchestrationDb,
  taskId: string,
  name: string
): WorkerFixture {
  const started = database.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER,
    taskId,
    startOptions: {}
  })
  const paneSuffix = name.length.toString(16).padStart(12, '0')
  const paneKey = `tab_${name}:aaaaaaaa-aaaa-4aaa-8aaa-${paneSuffix}`
  const incarnation = `${name}:1`
  const capability = database.prepareStartingWorkerAuthority({
    dispatchId: started.dispatch.id,
    handle: `term_${name}`,
    paneKey,
    processIncarnation: incarnation,
    worktreeId: `repo::${name}`,
    effects: [],
    setupState: 'not_applicable',
    terminalOwnership: 'created'
  })
  database.markWorkerStartUnknown(started.dispatch.id, 'turn_start_unobserved', 'no turn observed')
  return { dispatchId: started.dispatch.id, capability, paneKey, incarnation }
}

/** Spends the swallowed-Enter recovery window without waiting it out. */
function ageUnprovenState(database: OrchestrationDb, dispatchId: string): void {
  const entered = new Date(
    Date.now() - WORKER_UNPROVEN_LIFECYCLE_RECONCILE_AFTER_MS - 60_000
  ).toISOString()
  sqliteFor(database)
    .prepare('UPDATE worker_dispatches SET updated_at = ? WHERE dispatch_id = ?')
    .run(entered, dispatchId)
}

function projectDispatch(database: OrchestrationDb, dispatchId: string) {
  const now = Date.now()
  const rows = database.listWorkerTerminalResources({ dispatchIds: [dispatchId], limit: 1 })
  return projectWorkerFleet({
    rows,
    attentionFacts: database.getWorkerAttentionFactsForDispatches([dispatchId], now),
    statuses: [],
    limit: 1,
    now
  }).workers[0]!
}

function activeDispatchIds(database: OrchestrationDb, taskId: string): string[] {
  const rows = sqliteFor(database)
    .prepare(
      `SELECT id FROM dispatch_contexts
        WHERE task_id = ? AND status IN ('pending', 'dispatched')
        ORDER BY rowid`
    )
    .all(taskId) as { id: string }[]
  return rows.map((row) => row.id)
}

function expectCapability(database: OrchestrationDb, worker: WorkerFixture, valid: boolean): void {
  expect(
    database.verifyDispatchCapability({
      dispatchId: worker.dispatchId,
      capability: worker.capability,
      paneKey: worker.paneKey,
      processIncarnation: worker.incarnation
    }).valid
  ).toBe(valid)
}

function sqliteFor(database: OrchestrationDb): Database.Database {
  return (database as unknown as { db: Database.Database }).db
}
