import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../shared/orchestration-runtime-capabilities'
import Database from '../../sqlite/sync-database'
import { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationDb } from '../orchestration/db/orchestration-db'
import '../orchestration/db/contract-constants'
import '../orchestration/db/messages/mailbox-routing-page'
import '../orchestration/db/dispatch-row-writer'
import '../orchestration/db/attempt-outcome-projection'
import type { RpcRequest, RpcResponse } from './core'
import { RpcDispatcher } from './dispatcher'
import { ORCHESTRATION_METHODS } from './methods/orchestration/orchestration'
import { reattachDispatchConsumer } from '../orchestration/db/root-dispatch-test-fixture'

const COORDINATOR_HANDLE = 'term_invariant_coordinator'
const COORDINATOR_PANE = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const WORKER_HANDLE = 'term_invariant_worker'
const WORKER_PANE = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const WORKER_PROCESS = 'pty-worker:incarnation-1'

type Harness = {
  db: OrchestrationDb
  dbPath: string
  dispatcher: RpcDispatcher
  runId: string
}

const harnesses: Harness[] = []
const tempDirs: string[] = []
let requestSequence = 0

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.db.close()
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('Task/Dispatch state invariant', () => {
  it.each(['pending', 'dispatched'] as const)(
    'rejects a ready reset while the Dispatch is %s without mutating either row',
    async (dispatchStatus) => {
      const harness = createHarness()
      const task = harness.db.createTask({ spec: 'retain assignment', runId: harness.runId })
      const dispatch =
        dispatchStatus === 'pending'
          ? harness.db.createStartingWorkerDispatch({
              creator: { kind: 'system' },
              maxDepth: Number.MAX_SAFE_INTEGER,
              taskId: task.id,
              startOptions: {}
            }).dispatch
          : await dispatchTask(harness, task.id, WORKER_HANDLE)

      const response = await updateTask(harness, task.id, 'ready', 'must not persist')

      expect(response).toMatchObject({
        ok: false,
        error: {
          code: 'task_not_startable',
          data: { taskId: task.id, dispatchId: dispatch.id }
        }
      })
      expect(readPersistedPair(harness.dbPath, task.id, dispatch.id)).toEqual({
        taskStatus: 'dispatched',
        taskResult: null,
        taskCompletedAt: null,
        dispatchStatus,
        dispatchCompletedAt: null,
        capabilityRevokedAt: null
      })
    }
  )

  it('atomically fails a context-only Dispatch, revokes its capability, and frees the terminal', async () => {
    const harness = createHarness()
    const task = harness.db.createTask({ spec: 'failing assignment', runId: harness.runId })
    const { dispatch } = await createCapableDispatch(harness, task.id, 'dispatched')

    const response = await updateTask(harness, task.id, 'failed', 'coordinator stopped work')

    expect(response).toMatchObject({ ok: true, result: { task: { status: 'failed' } } })
    expect(readPersistedPair(harness.dbPath, task.id, dispatch.id)).toMatchObject({
      taskStatus: 'failed',
      taskResult: 'coordinator stopped work',
      taskCompletedAt: expect.any(String),
      dispatchStatus: 'failed',
      dispatchCompletedAt: expect.any(String),
      capabilityRevokedAt: expect.any(String)
    })

    const laterTask = harness.db.createTask({ spec: 'later assignment', runId: harness.runId })
    await expect(dispatchTask(harness, laterTask.id, WORKER_HANDLE)).resolves.toMatchObject({
      status: 'dispatched'
    })
  })

  it.each([
    ['pending', 'failed'],
    ['pending', 'completed'],
    ['dispatched', 'failed'],
    ['dispatched', 'completed']
  ] as const)(
    'rejects moving a %s supervised Dispatch Task to %s without mutating lifecycle state',
    async (dispatchStatus, taskStatus) => {
      const harness = createHarness()
      const task = harness.db.createTask({ spec: 'supervised assignment', runId: harness.runId })
      const { dispatch } = createSupervisedDispatch(harness, task.id, dispatchStatus)

      const response = await updateTask(harness, task.id, taskStatus, 'must not persist')

      expect(response).toMatchObject({
        ok: false,
        error: {
          code: 'task_not_startable',
          data: { taskId: task.id, dispatchId: dispatch.id }
        }
      })
      expect(readPersistedPair(harness.dbPath, task.id, dispatch.id)).toEqual({
        taskStatus: 'dispatched',
        taskResult: null,
        taskCompletedAt: null,
        dispatchStatus,
        dispatchCompletedAt: null,
        capabilityRevokedAt: null
      })
      expect(readPersistedWorkerState(harness.dbPath, dispatch.id)).toEqual({
        workerState: dispatchStatus === 'pending' ? 'starting' : 'ready',
        ownershipState: 'owned',
        releaseState: 'not_requested'
      })
    }
  )
})

function createHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'orca-task-dispatch-invariant-'))
  const dbPath = join(dir, 'orchestration.db')
  tempDirs.push(dir)
  const db = new OrchestrationDb(dbPath)
  const runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(db)
  vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) => {
    if (handle === COORDINATOR_HANDLE) {
      return COORDINATOR_PANE
    }
    if (handle === WORKER_HANDLE) {
      return WORKER_PANE
    }
    return null
  })
  const runId = db.createRun({
    objective: 'Enforce Task/Dispatch state',
    coordinatorHandle: COORDINATOR_HANDLE,
    coordinatorPaneKey: COORDINATOR_PANE
  }).id
  const harness = {
    db,
    dbPath,
    dispatcher: new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS }),
    runId
  }
  harnesses.push(harness)
  return harness
}

async function dispatchTask(
  harness: Harness,
  taskId: string,
  terminalHandle: string
): Promise<{ id: string; status: string }> {
  const response = await dispatchTaskResponse(harness, taskId, terminalHandle)
  if (!response.ok) {
    throw new Error(`${response.error.code}: ${response.error.message}`)
  }
  return (response.result as { dispatch: { id: string; status: string } }).dispatch
}

function dispatchTaskResponse(
  harness: Harness,
  taskId: string,
  terminalHandle: string
): Promise<RpcResponse> {
  return harness.dispatcher.dispatch(
    request('orchestration.dispatch', {
      task: taskId,
      to: terminalHandle,
      from: COORDINATOR_HANDLE,
      run: harness.runId
    })
  )
}

async function createCapableDispatch(
  harness: Harness,
  taskId: string,
  status: 'pending' | 'dispatched'
): Promise<{ dispatch: { id: string } }> {
  if (status === 'pending') {
    const dispatch = harness.db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId,
      startOptions: {}
    }).dispatch
    harness.db.prepareStartingWorkerAuthority({
      dispatchId: dispatch.id,
      handle: WORKER_HANDLE,
      paneKey: WORKER_PANE,
      processIncarnation: WORKER_PROCESS,
      worktreeId: 'repo::worker',
      setupState: 'not_applicable',
      effects: [],
      terminalOwnership: 'external'
    })
    return { dispatch }
  }
  const dispatch = await dispatchTask(harness, taskId, WORKER_HANDLE)
  reattachDispatchConsumer(harness.db, {
    dispatchId: dispatch.id,
    paneKey: WORKER_PANE,
    processIncarnation: WORKER_PROCESS
  })
  return { dispatch }
}

function createSupervisedDispatch(
  harness: Harness,
  taskId: string,
  status: 'pending' | 'dispatched'
): { dispatch: { id: string } } {
  const dispatch = harness.db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER,
    taskId,
    startOptions: {}
  }).dispatch
  harness.db.prepareStartingWorkerAuthority({
    dispatchId: dispatch.id,
    handle: WORKER_HANDLE,
    paneKey: WORKER_PANE,
    processIncarnation: WORKER_PROCESS,
    worktreeId: 'repo::worker',
    setupState: 'not_applicable',
    effects: [],
    terminalOwnership: 'created'
  })
  if (status === 'dispatched') {
    harness.db.markWorkerDispatchReady(dispatch.id)
  }
  return { dispatch }
}

function updateTask(
  harness: Harness,
  taskId: string,
  status: 'ready' | 'dispatched' | 'completed' | 'failed',
  result: string
): Promise<RpcResponse> {
  return harness.dispatcher.dispatch(
    request('orchestration.taskUpdate', {
      id: taskId,
      status,
      result,
      callerTerminalHandle: COORDINATOR_HANDLE,
      run: harness.runId
    })
  )
}

function request(method: string, params: Record<string, unknown>): RpcRequest {
  requestSequence += 1
  return {
    id: `rpc_task_dispatch_invariant_${requestSequence}`,
    authToken: 'test-token',
    method,
    params,
    orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
    orchestrationRequestId: `task_dispatch_invariant_${requestSequence}`
  }
}

function readPersistedPair(dbPath: string, taskId: string, dispatchId: string) {
  const sqlite = new Database(dbPath, { readonly: true })
  try {
    const task = sqlite
      .prepare('SELECT status, result, completed_at FROM tasks WHERE id = ?')
      .get(taskId) as { status: string; result: string | null; completed_at: string | null }
    const dispatch = sqlite
      .prepare(
        'SELECT status, completed_at, capability_revoked_at FROM dispatch_contexts WHERE id = ?'
      )
      .get(dispatchId) as {
      status: string
      completed_at: string | null
      capability_revoked_at: string | null
    }
    return {
      taskStatus: task.status,
      taskResult: task.result,
      taskCompletedAt: task.completed_at,
      dispatchStatus: dispatch.status,
      dispatchCompletedAt: dispatch.completed_at,
      capabilityRevokedAt: dispatch.capability_revoked_at
    }
  } finally {
    sqlite.close()
  }
}

function readPersistedWorkerState(dbPath: string, dispatchId: string) {
  const sqlite = new Database(dbPath, { readonly: true })
  try {
    const row = sqlite
      .prepare(
        `SELECT worker.state AS worker_state, resource.ownership_state, resource.release_state
         FROM worker_dispatches worker
         JOIN worker_terminal_resources resource ON resource.owner_dispatch_id = worker.dispatch_id
         WHERE worker.dispatch_id = ?`
      )
      .get(dispatchId) as {
      worker_state: string
      ownership_state: string
      release_state: string
    }
    return {
      workerState: row.worker_state,
      ownershipState: row.ownership_state,
      releaseState: row.release_state
    }
  } finally {
    sqlite.close()
  }
}
