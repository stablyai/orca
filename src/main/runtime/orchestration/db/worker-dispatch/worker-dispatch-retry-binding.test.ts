/**
 * openloop-i0lrpa.3177.3011: a same-task retry must mint a fresh dispatch/context/attempt
 * identity while retaining the parent-run and run-level consumer-generation binding the
 * original admission captured — even if the coordinator's Run is later rebound (which bumps
 * runs.consumer_generation) before the retry happens. The binding tuple is immutable per
 * attempt, not a live re-read of "whatever generation this Run is at now".
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'

const COORD_PANE = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

describe('worker-start --retry-of retains the parent-run binding', () => {
  let db: OrchestrationDb
  afterEach(() => db.close())

  function start(taskId: string, retryOf?: string): string {
    return db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId,
      retryOf,
      startOptions: {}
    }).dispatch.id
  }

  it('keeps run_id and the task-captured run generation across a retry, fresh dispatch id', () => {
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'retry binding',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: COORD_PANE
    })
    const task = db.createTask({
      runId: run.id,
      spec: 'flaky work',
      createdByRunGeneration: run.consumer_generation
    })

    const firstId = start(task.id)
    db.failWorkerStart(firstId, 'agent_readiness', 'crashed')

    // Why: a coordinator rebind between the failed attempt and the retry bumps the Run's
    // live consumer_generation. The retry must not pick that up — it is a different fencing
    // axis (coordinator authority over the Run), not the per-task admission generation.
    const beforeRetryGeneration = db.getTask(task.id)?.created_by_run_generation
    db.bindRun({
      runId: run.id,
      coordinatorHandle: 'term_other_coord',
      coordinatorPaneKey: 'tab_other_coord:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    })
    expect(db.getRun(run.id)?.consumer_generation).toBeGreaterThan(run.consumer_generation)

    const retriedId = start(task.id, firstId)

    const first = db.getDispatchContextById(firstId)
    const retried = db.getDispatchContextById(retriedId)
    expect(retried?.id).not.toBe(first?.id)
    expect(retried?.retry_of_dispatch_id).toBe(firstId)
    expect(retried?.run_id).toBe(run.id)
    expect(retried?.run_id).toBe(first?.run_id)
    expect(db.getTask(task.id)?.created_by_run_generation).toBe(beforeRetryGeneration)
    expect(db.getTask(task.id)?.created_by_run_generation).toBe(run.consumer_generation)
  })
})

/** The binding tuple (dispatch id, run id, consumer_generation) must survive a process restart. */
describe('dispatch binding durably reconstructs after reopening the database', () => {
  let tempDir: string | undefined
  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = undefined
    }
  })

  it('reads the same bound tuple by id, not by "latest", after a fresh OrchestrationDb open', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-i0lrpa-3177-3011-'))
    const dbPath = join(tempDir, 'orchestration.db')

    const before = new OrchestrationDb(dbPath)
    const run = before.createRun({
      objective: 'restart durability',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: COORD_PANE
    })
    const task = before.createTask({
      runId: run.id,
      spec: 'survives a restart',
      createdByRunGeneration: run.consumer_generation
    })
    const dispatchId = before.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    }).dispatch.id
    // A second, later dispatch on an unrelated task must not be what a restart "latest" lookup
    // would return in place of the exact id above — the reconstruction must be by id.
    const otherTask = before.createTask({
      runId: run.id,
      spec: 'unrelated, created later',
      createdByRunGeneration: run.consumer_generation
    })
    before.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: otherTask.id,
      startOptions: {}
    })
    const beforeGeneration = before.getDispatchContextById(dispatchId)?.consumer_generation
    before.close()

    const reopened = new OrchestrationDb(dbPath)
    try {
      const reconstructed = reopened.getDispatchContextById(dispatchId)
      expect(reconstructed?.id).toBe(dispatchId)
      expect(reconstructed?.run_id).toBe(run.id)
      expect(reconstructed?.task_id).toBe(task.id)
      expect(reconstructed?.consumer_generation).toBe(beforeGeneration)
    } finally {
      reopened.close()
    }
  })
})
