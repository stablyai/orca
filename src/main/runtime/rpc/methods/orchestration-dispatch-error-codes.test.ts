import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../shared/protocol-version'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import type { RpcRequest, RpcResponse } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { ORCHESTRATION_METHODS } from './orchestration'
import type { RpcFailure } from '../core'

// Why: the CLI is a separate tsconfig project, so it is loaded at runtime (like the CLI/runtime
// boundary test) instead of imported statically, which the composite node typecheck rejects.
type CliErrorContext = { commandPath?: string[] }
type CliFailureError = Error & { code: string }
type CliFormat = {
  formatCliError: (error: unknown, context?: CliErrorContext) => string
  reportCliError: (error: unknown, json: boolean, context?: CliErrorContext) => void
}
type CliRuntimeTypes = {
  RuntimeRpcFailureError: new (response: RpcFailure) => CliFailureError
}

const COORDINATOR_HANDLE = 'term_codes_coordinator'
const COORDINATOR_PANE = 'tab_coord:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const WORKER_HANDLE = 'term_codes_worker'
const WORKER_PANE = 'tab_worker:dddddddd-dddd-4ddd-8ddd-dddddddddddd'

type Harness = {
  db: OrchestrationDb
  runtime: OrcaRuntimeService
  dispatcher: RpcDispatcher
}

const harnesses: Harness[] = []
let requestSequence = 0

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.db.close()
  }
  vi.restoreAllMocks()
})

async function loadCli(): Promise<{ format: CliFormat; types: CliRuntimeTypes }> {
  const cliFormatPath = '../../../../cli/format'
  const cliTypesPath = '../../../../cli/runtime/types'
  return {
    format: (await import(cliFormatPath)) as CliFormat,
    types: (await import(cliTypesPath)) as CliRuntimeTypes
  }
}

// Why: an agent reads the receipt code to pick a recovery; every case is driven from the real
// RPC dispatcher through the CLI's own failure conversion, never from a hand-built error.
describe('orchestration dispatch failure codes reach the CLI', () => {
  it('reports task_not_found for a task id that does not exist', async () => {
    const harness = createHarness()

    const response = await dispatch(harness, {
      task: 'task_missing',
      to: WORKER_HANDLE
    })

    const failure = expectFailure(response)
    expect(failure.error.code).toBe('task_not_found')
    expect(failure.error.data).toMatchObject({ taskId: 'task_missing' })
    await expectCliSurfacesCode(failure, 'task_not_found', /task-create|task-list/)
  })

  it('reports task_not_ready with the unmet dependencies for a pending task', async () => {
    const harness = createHarness()
    const parent = harness.db.createTask({ spec: 'parent' })
    const child = harness.db.createTask({ spec: 'child', deps: [parent.id] })

    const response = await dispatch(harness, {
      task: child.id,
      to: WORKER_HANDLE
    })

    const failure = expectFailure(response)
    expect(failure.error.code).toBe('task_not_ready')
    expect(failure.error.data).toMatchObject({
      taskId: child.id,
      status: 'pending',
      unmetDependencies: [parent.id]
    })
    await expectCliSurfacesCode(failure, 'task_not_ready', new RegExp(parent.id))
    expect(harness.db.getTask(child.id)?.status).toBe('pending')
  })

  it('reports task_not_ready with the status for a completed task', async () => {
    const harness = createHarness()
    const task = harness.db.createTask({ spec: 'done' })
    harness.db.updateTaskStatus(task.id, 'completed')

    const response = await dispatch(harness, {
      task: task.id,
      to: WORKER_HANDLE
    })

    const failure = expectFailure(response)
    expect(failure.error.code).toBe('task_not_ready')
    expect(failure.error.data).toMatchObject({
      taskId: task.id,
      status: 'completed',
      unmetDependencies: []
    })
  })

  it('reports inject_rejected when the target terminal runs no recognized agent', async () => {
    const harness = createHarness()
    const task = harness.db.createTask({ spec: 'work' })
    vi.spyOn(harness.runtime, 'isTerminalRunningAgent').mockResolvedValue(false)

    const response = await dispatch(harness, {
      task: task.id,
      to: WORKER_HANDLE,
      inject: true
    })

    const failure = expectFailure(response)
    expect(failure.error.code).toBe('inject_rejected')
    expect(failure.error.data).toMatchObject({
      terminal: WORKER_HANDLE,
      reason: 'no_agent_detected'
    })
    await expectCliSurfacesCode(failure, 'inject_rejected', /without --inject/)
    expect(harness.db.getTask(task.id)?.status).toBe('ready')
    expect(harness.db.getDispatchContext(task.id)).toBeUndefined()
  })

  it('reports task_not_ready from worker-start, which composes dispatch', async () => {
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

    const failure = expectFailure(response)
    expect(failure.error.code).toBe('task_not_ready')
    expect(failure.error.data).toMatchObject({
      taskId: child.id,
      status: 'pending',
      unmetDependencies: [parent.id]
    })
    expect(harness.db.getTask(child.id)?.status).toBe('pending')
  })

  it('keeps runtime_error for a genuinely unexpected dispatch failure', async () => {
    const harness = createHarness()
    const task = harness.db.createTask({ spec: 'work' })
    vi.spyOn(harness.runtime, 'isTerminalRunningAgent').mockRejectedValue(
      new Error('probe exploded')
    )

    const response = await dispatch(harness, {
      task: task.id,
      to: WORKER_HANDLE,
      inject: true
    })

    expect(expectFailure(response).error).toMatchObject({
      code: 'runtime_error',
      message: 'probe exploded'
    })
  })
})

/** Mirrors an older CLI: it never enumerates codes, so an unknown code must still print. */
async function expectCliSurfacesCode(
  failure: RpcFailure,
  code: string,
  recovery: RegExp
): Promise<void> {
  const { format, types } = await loadCli()
  const error = new types.RuntimeRpcFailureError(failure)
  expect(error.code).toBe(code)
  const human = format.formatCliError(error, { commandPath: ['orchestration', 'dispatch'] })
  expect(human).toContain(failure.error.message)
  expect(human).toMatch(recovery)

  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    format.reportCliError(error, true, { commandPath: ['orchestration', 'dispatch'] })
    const printed = JSON.parse(log.mock.calls[0]?.[0] as string) as RpcFailure
    expect(printed.ok).toBe(false)
    expect(printed.error.code).toBe(code)
    expect(printed.error.data).toEqual(failure.error.data)
  } finally {
    log.mockRestore()
  }
}

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
