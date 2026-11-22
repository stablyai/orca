import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../../../sqlite/sync-database'
import { OrchestrationDb } from '../orchestration-db'
import '../contract-constants'
import '../messages/mailbox-routing-page'
import '../dispatch-row-writer'
import '../attempt-outcome-projection'
import { createRootDispatch } from '../root-dispatch-test-fixture'

type WorkerFixture = {
  dispatchId: string
  handle: string
  paneKey: string
  processIncarnation: string
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

describe('Task/Dispatch lifecycle guards', () => {
  it('rejects generic failure while a supervised worker remains active', () => {
    const database = createDatabase()
    const task = database.createTask({
      runId: 'run_legacy_local',
      spec: 'supervised failure guard'
    })
    const worker = startWorker(database, task.id, 'guarded')

    expect(() => database.failDispatch(worker.dispatchId, 'unsafe retry')).toThrowError(
      expect.objectContaining({
        code: 'task_not_startable',
        data: { dispatchId: worker.dispatchId }
      })
    )
    expect(database.getTask(task.id)?.status).toBe('dispatched')
    expect(database.getDispatchContextById(worker.dispatchId)).toMatchObject({
      status: 'dispatched',
      failure_count: 0,
      capability_revoked_at: null
    })
    expect(database.getWorkerDispatch(worker.dispatchId)?.state).toBe('ready')
  })

  it('atomically settles worker state when a proven process exit fails its Dispatch', () => {
    const database = createDatabase()
    const task = database.createTask({
      runId: 'run_legacy_local',
      spec: 'exited worker'
    })
    const worker = startWorker(database, task.id, 'exited')

    expect(
      database.failDispatch(worker.dispatchId, 'process exited', { workerProcessExited: true })
    ).toMatchObject({ status: 'failed', failure_count: 1 })
    expect(database.getTask(task.id)?.status).toBe('ready')
    expect(database.getWorkerDispatch(worker.dispatchId)).toMatchObject({
      state: 'failed',
      stage: 'process_exited',
      last_error: 'process exited'
    })
  })

  it('settles a stop-unknown worker when a positive PTY exit arrives', () => {
    const database = createDatabase()
    const task = database.createTask({
      runId: 'run_legacy_local',
      spec: 'stop-unknown exited worker'
    })
    const worker = startWorker(database, task.id, 'stop_unknown_exited')

    expect(database.beginWorkerStop(worker.dispatchId, 'runtime_test').disposition).toBe('stopping')
    expect(database.markWorkerStopUnknown(worker.dispatchId, 'stop response lost').state).toBe(
      'stop_unknown'
    )

    expect(() =>
      database.failDispatch(worker.dispatchId, 'process exited', {
        workerProcessExited: true,
        terminationReason: 'exited'
      })
    ).not.toThrow()
    expect(database.getTask(task.id)?.status).toBe('blocked')
    expect(database.getDispatchContextById(worker.dispatchId)).toMatchObject({
      status: 'failed',
      termination_reason: 'exited',
      capability_revoked_at: expect.any(String)
    })
    expect(database.getWorkerDispatch(worker.dispatchId)).toMatchObject({
      state: 'failed',
      stage: 'process_exited',
      last_error: 'process exited'
    })
  })

  it('atomically preserves an uncertain federated Dispatch while blocking its Task', () => {
    const database = createDatabase()
    const run = database.createRun({
      objective: 'Federated restart uncertainty',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:11111111-1111-4111-8111-111111111111'
    })
    const task = database.createTask({
      spec: 'federated restart uncertainty',
      runId: run.id
    })
    const started = database.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {},
      federation: {
        environmentId: 'server-1',
        environmentName: 'worker server',
        peerFingerprint: 'peer-1',
        protocolVersion: 3
      }
    })
    const question = database.createQuestion({
      runId: run.id,
      dispatchId: started.dispatch.id,
      askerHandle: 'term_worker',
      question: 'Should the uncertain worker resume?'
    })

    database.reconcileFederatedWorkerStart({
      dispatchId: started.dispatch.id,
      state: 'start_unknown',
      stage: 'remote_attach',
      lastError: 'worker server restarted'
    })

    expect(database.getWorkerDispatch(started.dispatch.id)).toMatchObject({
      state: 'start_unknown',
      stage: 'remote_attach',
      last_error: 'worker server restarted'
    })
    expect(database.getDispatchContextById(started.dispatch.id)?.status).toBe('pending')
    expect(database.getTask(task.id)?.status).toBe('blocked')
    expect(database.getQuestion(question.message.id)?.status).toBe('pending')
    const settled = {
      worker: database.getWorkerDispatch(started.dispatch.id),
      dispatch: database.getDispatchContextById(started.dispatch.id),
      task: database.getTask(task.id)
    }

    database.reconcileFederatedWorkerStart({
      dispatchId: started.dispatch.id,
      state: 'start_unknown',
      stage: 'remote_attach',
      lastError: 'worker server restarted'
    })

    expect(database.getWorkerDispatch(started.dispatch.id)).toEqual(settled.worker)
    expect(database.getDispatchContextById(started.dispatch.id)).toEqual(settled.dispatch)
    expect(database.getTask(task.id)).toEqual(settled.task)
    const answered = database.answerQuestion({
      messageId: question.message.id,
      runId: run.id,
      consumerGeneration: run.consumer_generation,
      body: 'yes'
    })
    expect(answered.question.status).toBe('answered')
    expect(answered.message.body).toBe('yes')
  })

  it('rolls back federated start uncertainty when the Task transition cannot commit', () => {
    const database = createDatabase()
    const task = database.createTask({
      runId: 'run_legacy_local',
      spec: 'atomic federated uncertainty'
    })
    const started = database.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {},
      federation: {
        environmentId: 'server-1',
        environmentName: 'worker server',
        peerFingerprint: 'peer-1',
        protocolVersion: 3
      }
    })
    sqliteFor(database).exec(`
      CREATE TRIGGER reject_federated_unknown_task_block
      BEFORE UPDATE ON tasks
      WHEN NEW.status = 'blocked'
      BEGIN SELECT RAISE(ABORT, 'forced federated uncertainty task block failure'); END;
    `)

    expect(() =>
      database.reconcileFederatedWorkerStart({
        dispatchId: started.dispatch.id,
        state: 'start_unknown',
        stage: 'remote_attach',
        lastError: 'worker server restarted'
      })
    ).toThrow('forced federated uncertainty task block failure')
    expect(database.getWorkerDispatch(started.dispatch.id)).toMatchObject({
      state: 'starting',
      stage: 'accepted',
      last_error: null
    })
    expect(database.getDispatchContextById(started.dispatch.id)?.status).toBe('pending')
    expect(database.getTask(task.id)?.status).toBe('dispatched')
  })

  it('rolls back both context-only projections when the Task transition fails', () => {
    const database = createDatabase()
    const task = database.createTask({
      runId: 'run_legacy_local',
      spec: 'context-only atomic receipt'
    })
    const contextOnly = createRootDispatch(database, task.id, 'term_context')
    sqliteFor(database).exec(`
      CREATE TRIGGER reject_context_release_task_block
      BEFORE UPDATE ON tasks
      WHEN NEW.status = 'blocked'
      BEGIN SELECT RAISE(ABORT, 'forced context release task block failure'); END;
    `)

    expect(() => database.beginWorkerStop(contextOnly.id, 'runtime_test')).toThrow(
      'forced context release task block failure'
    )
    expect(database.getTask(task.id)?.status).toBe('dispatched')
    expect(database.getDispatchContextById(contextOnly.id)).toMatchObject({
      status: 'dispatched',
      last_failure: null,
      completed_at: null,
      capability_revoked_at: null
    })
  })

  it('rejects gate creation while a supervised worker remains active', () => {
    const database = createDatabase()
    const task = database.createTask({
      runId: 'run_legacy_local',
      spec: 'worker gate guard'
    })
    const worker = startWorker(database, task.id, 'gate')

    expect(() => database.createGate({ taskId: task.id, question: 'Proceed?' })).toThrowError(
      expect.objectContaining({
        code: 'task_not_startable',
        data: { taskId: task.id, dispatchId: worker.dispatchId }
      })
    )
    expect(database.listGates({ taskId: task.id })).toHaveLength(0)
    expect(database.getTask(task.id)?.status).toBe('dispatched')
    expect(database.getDispatchContextById(worker.dispatchId)?.status).toBe('dispatched')
    expect(database.getWorkerDispatch(worker.dispatchId)?.state).toBe('ready')
  })
})

function createDatabase(): OrchestrationDb {
  dir = mkdtempSync(join(tmpdir(), 'orca-task-dispatch-lifecycle-'))
  db = new OrchestrationDb(join(dir, 'orchestration.db'))
  return db
}

function startWorker(database: OrchestrationDb, taskId: string, name: string): WorkerFixture {
  const started = database.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER,
    taskId,
    startOptions: {}
  })
  const paneSuffix = name.length.toString(16).padStart(12, '0')
  const paneKey = `tab_${name}:aaaaaaaa-aaaa-4aaa-8aaa-${paneSuffix}`
  const processIncarnation = `${name}:1`
  const handle = `term_${name}`
  database.prepareStartingWorkerAuthority({
    dispatchId: started.dispatch.id,
    handle,
    paneKey,
    processIncarnation,
    worktreeId: `repo::${name}`,
    effects: [],
    setupState: 'not_applicable',
    terminalOwnership: 'created'
  })
  database.markWorkerDispatchReady(started.dispatch.id)
  return { dispatchId: started.dispatch.id, handle, paneKey, processIncarnation }
}

function sqliteFor(database: OrchestrationDb): Database.Database {
  return (database as unknown as { db: Database.Database }).db
}
