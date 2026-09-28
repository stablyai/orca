import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../shared/protocol-version'
import {
  buildInjectRejectionMessage,
  injectRejectedRefusal,
  taskNotFoundRefusal,
  taskNotStartableRefusal
} from '../../../../shared/orchestration-dispatch-refusal-contract'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import type { RpcFailure, RpcRequest, RpcResponse } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { ORCHESTRATION_METHODS } from './orchestration'

const COORDINATOR_HANDLE = 'term_codes_coordinator'
const COORDINATOR_PANE = 'tab_coord:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const WORKER_HANDLE = 'term_codes_worker'
const WORKER_PANE = 'tab_worker:dddddddd-dddd-4ddd-8ddd-dddddddddddd'

type Harness = { db: OrchestrationDb; runtime: OrcaRuntimeService; dispatcher: RpcDispatcher }

const harnesses: Harness[] = []
let requestSequence = 0

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.db.close()
  }
  vi.restoreAllMocks()
})

// Why: an agent reads the receipt code to pick a recovery; every case is driven from the real
// RPC dispatcher and checked against the shared contract the CLI-side test formats.
describe('orchestration dispatch failure codes through RpcDispatcher', () => {
  it('reports task_not_found for a task id that does not exist', async () => {
    const harness = createHarness()

    const response = await dispatch(harness, { task: 'task_missing', to: WORKER_HANDLE })

    expect(expectFailure(response).error).toEqual(
      taskNotFoundRefusal('Task not found: task_missing', { taskId: 'task_missing' })
    )
  })

  it('reports task_not_startable with the unmet dependencies for a pending task', async () => {
    const harness = createHarness()
    const parent = harness.db.createTask({ spec: 'parent' })
    const child = harness.db.createTask({ spec: 'child', deps: [parent.id] })

    const response = await dispatch(harness, { task: child.id, to: WORKER_HANDLE })

    expect(expectFailure(response).error).toEqual(
      taskNotStartableRefusal(`Task ${child.id} is pending; only ready tasks can be dispatched`, {
        taskId: child.id,
        status: 'pending',
        unmetDependencies: [parent.id]
      })
    )
    expect(harness.db.getTask(child.id)?.status).toBe('pending')
  })

  it('reports task_not_startable with the status for a completed task', async () => {
    const harness = createHarness()
    const task = harness.db.createTask({ spec: 'done' })
    harness.db.updateTaskStatus(task.id, 'completed')

    const response = await dispatch(harness, { task: task.id, to: WORKER_HANDLE })

    expect(expectFailure(response).error).toEqual(
      taskNotStartableRefusal(`Task ${task.id} is completed; only ready tasks can be dispatched`, {
        taskId: task.id,
        status: 'completed',
        unmetDependencies: []
      })
    )
  })

  it('reports inject_rejected when the target terminal runs no recognized agent', async () => {
    const harness = createHarness()
    const task = harness.db.createTask({ spec: 'work' })
    vi.spyOn(harness.runtime, 'isTerminalRunningAgent').mockResolvedValue(false)

    const response = await dispatch(harness, { task: task.id, to: WORKER_HANDLE, inject: true })

    expect(expectFailure(response).error).toEqual(
      injectRejectedRefusal(WORKER_HANDLE, 'no_agent_detected')
    )
    expect(expectFailure(response).error.message).toBe(buildInjectRejectionMessage(WORKER_HANDLE))
    expect(harness.db.getTask(task.id)?.status).toBe('ready')
    expect(harness.db.getDispatchContext(task.id)).toBeUndefined()
  })

  it('reports task_not_startable with dependency detail from worker-start', async () => {
    const harness = createHarness()
    const parent = harness.db.createTask({ spec: 'parent' })
    const child = harness.db.createTask({ spec: 'child', deps: [parent.id] })
    mockWorkerStartTopology(harness.runtime)

    const response = await harness.dispatcher.dispatch(
      request('orchestration.workerStart', {
        task: child.id,
        from: COORDINATOR_HANDLE,
        agent: 'claude'
      })
    )

    expect(expectFailure(response).error).toEqual(
      taskNotStartableRefusal(`Task ${child.id} is pending; only a ready Task can start.`, {
        taskId: child.id,
        status: 'pending',
        unmetDependencies: [parent.id]
      })
    )
    expect(harness.db.getTask(child.id)?.status).toBe('pending')
  })

  it('reports task_not_startable with retry detail for an invalid --retry-of', async () => {
    const harness = createHarness()
    const task = harness.db.createTask({ spec: 'work' })
    mockWorkerStartTopology(harness.runtime)

    const response = await harness.dispatcher.dispatch(
      request('orchestration.workerStart', {
        task: task.id,
        from: COORDINATOR_HANDLE,
        agent: 'claude',
        retryOf: 'ctx_missing'
      })
    )

    expect(expectFailure(response).error).toEqual(
      taskNotStartableRefusal(`Task ${task.id} cannot retry from Dispatch ctx_missing.`, {
        taskId: task.id,
        status: 'ready',
        unmetDependencies: [],
        retryOf: 'ctx_missing'
      })
    )
  })

  it('types the atomic claim loser when the task changes after the ready precheck', async () => {
    const harness = createHarness()
    const task = harness.db.createTask({ spec: 'raced' })
    // Why: the pane lookup runs after the ready precheck and before the DB claim, so failing the
    // task there is the interleaving a concurrent status change produces. The loser's DB refusal
    // must carry the same typed receipt instead of the bare Error it used to throw.
    vi.mocked(harness.runtime.getTerminalPaneKey).mockImplementation((handle) => {
      if (handle === WORKER_HANDLE) {
        harness.db.updateTaskStatus(task.id, 'failed', 'raced out')
        return WORKER_PANE
      }
      return handle === COORDINATOR_HANDLE ? COORDINATOR_PANE : null
    })

    const response = await dispatch(harness, { task: task.id, to: WORKER_HANDLE })

    expect(expectFailure(response).error).toEqual(
      taskNotStartableRefusal(`Task ${task.id} is failed; only ready tasks can be dispatched`, {
        taskId: task.id,
        status: 'failed',
        unmetDependencies: []
      })
    )
    expect(harness.db.getDispatchContext(task.id)).toBeUndefined()
  })

  it('keeps runtime_error for a genuinely unexpected dispatch failure', async () => {
    const harness = createHarness()
    const task = harness.db.createTask({ spec: 'work' })
    vi.spyOn(harness.runtime, 'isTerminalRunningAgent').mockRejectedValue(
      new Error('probe exploded')
    )

    const response = await dispatch(harness, { task: task.id, to: WORKER_HANDLE, inject: true })

    expect(expectFailure(response).error).toMatchObject({
      code: 'runtime_error',
      message: 'probe exploded'
    })
  })
})

function expectFailure(response: RpcResponse): RpcFailure {
  if (response.ok) {
    throw new Error(`Expected a failure, got ${JSON.stringify(response.result)}`)
  }
  return response
}

function createHarness(): Harness {
  const db = new OrchestrationDb(':memory:')
  const runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(db)
  vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
    handle === COORDINATOR_HANDLE ? COORDINATOR_PANE : handle === WORKER_HANDLE ? WORKER_PANE : null
  )
  vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
    handle === WORKER_HANDLE ? 'pty-worker:incarnation-1' : null
  )
  const runId = db.createRun({
    objective: 'Typed dispatch failures',
    coordinatorHandle: COORDINATOR_HANDLE,
    coordinatorPaneKey: COORDINATOR_PANE
  }).id
  const createTask = db.createTask.bind(db)
  db.createTask = (task) => createTask({ ...task, runId: task.runId ?? runId })
  const harness = {
    db,
    runtime,
    dispatcher: new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
  }
  harnesses.push(harness)
  return harness
}

function mockWorkerStartTopology(runtime: OrcaRuntimeService): void {
  vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
  vi.spyOn(runtime, 'showTerminal').mockImplementation(
    async (handle) => ({ handle, worktreeId: 'repo::worktree', status: 'running' }) as never
  )
  vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
    id: 'repo::worktree'
  } as never)
}

function dispatch(harness: Harness, params: Record<string, unknown>): Promise<RpcResponse> {
  return harness.dispatcher.dispatch(
    request('orchestration.dispatch', { from: COORDINATOR_HANDLE, ...params })
  )
}

function request(method: string, params: Record<string, unknown>): RpcRequest {
  requestSequence += 1
  return {
    id: `rpc_dispatch_error_codes_${requestSequence}`,
    authToken: 'test-token',
    method,
    params,
    orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
    orchestrationRequestId: `dispatch_error_codes_${requestSequence}`
  }
}
