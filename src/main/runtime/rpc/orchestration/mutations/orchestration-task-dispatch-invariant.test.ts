import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../../shared/orchestration/orchestration-runtime-capabilities'
import Database from '../../../../sqlite/sync-database'
import { OrcaRuntimeService } from '../../../orca-runtime'
import { OrchestrationDb } from '../../../orchestration/db/orchestration-db'
import '../../../orchestration/db/contract-constants'
import '../../../orchestration/db/messages/mailbox-routing-page'
import '../../../orchestration/db/dispatch-row-writer'
import '../../../orchestration/db/attempt-outcome-projection'
import type { RpcRequest, RpcResponse } from '../../core'
import { RpcDispatcher } from '../../dispatcher'
import { ORCHESTRATION_METHODS } from '../../methods/orchestration/orchestration'
import { reattachDispatchConsumer } from '../../../orchestration/db/root-dispatch-test-fixture'

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
