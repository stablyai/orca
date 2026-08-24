import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import {
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { ORCHESTRATION_METHODS } from './orchestration'

describe('orchestration worker-start --spec', () => {
  const coordinatorPaneKey = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let runId: string

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    runId = db.createRun({
      objective: 'Test worker-start --spec',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey
    }).id
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord'
        ? coordinatorPaneKey
        : handle === 'term_worker'
          ? 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
          : null
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
      handle === 'term_worker' ? 'runtime_test:term_worker:1' : null
    )
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(runtime, 'showTerminal').mockResolvedValue({
      handle: 'term_coord',
      worktreeId: 'repo::parent',
      status: 'running'
    } as never)
    vi.spyOn(runtime, 'showManagedWorktree').mockResolvedValue({
      id: 'repo::parent',
      repoId: 'repo'
    } as never)
    vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
      id: 'repo::parent',
      repoId: 'repo'
    } as never)
    vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
      handle: 'term_worker',
      surface: 'workspace'
    } as never)
    vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
      handle: 'term_worker',
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
      handle: 'term_worker',
      accepted: true,
      bytesWritten: 1
    })
  })

  afterEach(() => db.close())

  function workerStartMethod() {
    const method = ORCHESTRATION_METHODS.find(
      (candidate) => candidate.name === 'orchestration.workerStart'
    )
    if (!method) {
      throw new Error('workerStart method is not registered')
    }
    return method
  }

  // Why: the runtime always receives a mutation receipt for workerStart (the CLI derives or
  // generates the request id), so tests must supply one or the federated path short-circuits
  // on its durable-request guard before reaching any real preflight.
  const orchestrationMutation = {
    callerFingerprint: 'caller',
    requestId: 'worker_start_request',
    method: 'orchestration.workerStart',
    payloadHash: 'payload'
  }

  async function startWorker(overrides: Record<string, unknown> = {}) {
    const method = workerStartMethod()
    const params = method.params!.parse({
      spec: 'Inline worker task',
      from: 'term_coord',
      worktree: 'current',
      agent: 'codex',
      ...overrides
    })
    return (await method.handler(params, { runtime, orchestrationMutation })) as {
      runId: string
      taskId: string
      dispatchId: string
      state: string
      failedStage?: string
    }
  }

  function mockWorktreeCreation() {
    vi.spyOn(runtime, 'showRepo').mockResolvedValue({ id: 'repo', kind: 'git' } as never)
    vi.spyOn(runtime, 'createManagedWorktree').mockResolvedValue({
      worktree: { id: 'repo::child', repoId: 'repo' },
      startupTerminal: { handle: 'term_worker' },
      setupReceipt: {
        state: 'not_configured',
        startupPolicy: 'start-immediately',
        hookFound: false
      }
    } as never)
    vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
      terminals: [{ handle: 'term_worker', tabId: 'tab_worker', leafId: 'leaf_worker' }]
    } as never)
  }

  function captureError(run: () => unknown): unknown {
    try {
      run()
    } catch (error) {
      return error
    }
    throw new Error('expected the call to throw')
  }

  function mockWorkerServer(capabilities: string[]) {
    vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockReturnValue({
      environmentId: 'environment_windows',
      name: 'windows',
      peerFingerprint: 'windows_peer'
    } as never)
    return vi
      .spyOn(runtime, 'callOrchestrationWorkerServer')
      .mockResolvedValue({ capabilities } as never)
  }

  it('creates the task and dispatches it in the same call', async () => {
    const result = await startWorker({ taskTitle: 'Inline title' })

    expect(result.state).toBe('ready')
    expect(result.runId).toBe(runId)
    const task = db.getTask(result.taskId)
    expect(task).toMatchObject({
      run_id: runId,
      spec: 'Inline worker task',
      task_title: 'Inline title',
      created_by_terminal_handle: 'term_coord'
    })
  })

  it('creates the inline task and a new child worktree in the same call', async () => {
    mockWorktreeCreation()

    const result = await startWorker({ worktree: 'new-child', name: 'inline-child' })

    expect(result.state).toBe('ready')
    expect(db.getTask(result.taskId)).toMatchObject({
      run_id: runId,
      spec: 'Inline worker task',
      status: 'dispatched'
    })
    expect(runtime.createManagedWorktree).toHaveBeenCalledOnce()
  })

  it('keeps the created task traceable when new-worktree creation fails', async () => {
    mockWorktreeCreation()
    vi.mocked(runtime.createManagedWorktree).mockRejectedValue(new Error('worktree create failed'))

    const result = await startWorker({ worktree: 'new-top-level', name: 'inline-top' })

    expect(result.state).toBe('failed')
    expect(result.failedStage).toBe('worktree_create')
    // Why: the Task is committed with the dispatch, so a later stage failure stays traceable
    // through the receipt instead of vanishing with the rolled-back resources.
    expect(db.getTask(result.taskId)).toMatchObject({ run_id: runId, spec: 'Inline worker task' })
  })

  it('keeps the created task traceable when the dispatch fails', async () => {
    vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockRejectedValue(
      new Error('agent prompt rejected')
    )

    const result = await startWorker()

    expect(result.state).toBe('failed')
    expect(result.failedStage).toBe('dispatch_input')
    expect(result.taskId).toBeTruthy()
    expect(db.getTask(result.taskId)).toMatchObject({
      run_id: runId,
      spec: 'Inline worker task'
    })
  })

  it('creates no task when local preflight validation rejects the launch', async () => {
    await expect(startWorker({ terminal: 'term_worker' })).rejects.toMatchObject({
      code: 'invalid_argument'
    })

    expect(db.listTasks({ runId })).toHaveLength(0)
  })

  it('creates no task when federated placement validation rejects the launch', async () => {
    // Why: new-top-level without --name fails inside validateFederatedWorkerStartPlacement,
    // proving the rejection happens in real federated preflight, not on the receipt guard.
    await expect(
      startWorker({ on: 'windows', worktree: 'new-top-level', repo: 'id:windows-repo' })
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('Remote new-top-level requires --name')
    })

    expect(db.listTasks({ runId })).toHaveLength(0)
  })

  it('creates no task when the connected worker server lacks federation support', async () => {
    mockWorkerServer([ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY])

    await expect(
      startWorker({
        on: 'windows',
        worktree: 'new-top-level',
        name: 'remote-work',
        repo: 'id:windows-repo'
      })
    ).rejects.toMatchObject({
      code: 'capability_unsupported',
      message: expect.stringContaining('does not support orchestration federation')
    })

    expect(db.listTasks({ runId })).toHaveLength(0)
  })

  it('creates the inline task and attaches it remotely on the federated path', async () => {
    const remoteCall = mockWorkerServer([
      ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
      ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY
    ])
    remoteCall.mockImplementation(async (_environmentId, method, payload) => {
      if (method === 'status.get') {
        return {
          capabilities: [
            ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
            ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY
          ]
        } as never
      }
      const attach = payload as { dispatchId: string }
      return {
        dispatchId: attach.dispatchId,
        state: 'ready',
        runtimeEpoch: 'remote_epoch',
        worktreeId: 'remote::worktree',
        terminalHandle: 'term_remote',
        effects: []
      } as never
    })

    const result = await startWorker({
      on: 'windows',
      worktree: 'new-top-level',
      name: 'remote-work',
      repo: 'id:windows-repo',
      taskTitle: 'Remote title'
    })

    expect(result.state).toBe('ready')
    const tasks = db.listTasks({ runId })
    expect(tasks).toHaveLength(1)
    expect(db.getTask(result.taskId)).toMatchObject({
      run_id: runId,
      spec: 'Inline worker task',
      task_title: 'Remote title'
    })
    // Why: the remote side must be handed the Task created inside the same transaction.
    const attachCall = remoteCall.mock.calls.find(
      (call) => call[1] === 'orchestration.federationAttachStart'
    )
    expect(attachCall?.[2]).toMatchObject({
      taskId: result.taskId,
      taskSpec: 'Inline worker task'
    })
  })

  it('rolls back the created task when dispatch acceptance fails inside the transaction', () => {
    expect(() =>
      db.createStartingWorkerDispatch({
        createTask: { spec: 'Inline worker task', runId },
        retryOf: 'ctx_missing',
        startOptions: {}
      })
    ).toThrow(/cannot retry/)

    expect(db.listTasks({ runId })).toHaveLength(0)
  })

  // Why: the receipt conflict fires before task creation, so this asserts the ordering -
  // not rollback. The retryOf case above is what covers rollback-after-create.
  it('rejects a conflicting mutation receipt before it ever creates the task', () => {
    db.beginMutationReceipt({
      callerFingerprint: 'caller',
      requestId: 'req_1',
      method: 'orchestration.workerStart',
      payloadHash: 'original'
    })

    expect(() =>
      db.createStartingWorkerDispatch({
        createTask: { spec: 'Inline worker task', runId },
        startOptions: {},
        mutationReceipt: {
          callerFingerprint: 'caller',
          requestId: 'req_1',
          method: 'orchestration.workerStart',
          payloadHash: 'different'
        }
      })
    ).toThrow(/already used with different input/)

    expect(db.listTasks({ runId })).toHaveLength(0)
  })

  it('maps a plain createTask failure to a classified orchestration error', () => {
    const error = captureError(() =>
      db.createStartingWorkerDispatch({
        createTask: { spec: 'Inline worker task', runId: 'run_missing' },
        startOptions: {}
      })
    )

    expect(error).toMatchObject({ name: 'OrchestrationError', code: 'invalid_argument' })

    expect(db.listTasks({ runId })).toHaveLength(0)
  })

  it('rejects both taskId and createTask in the same acceptance', () => {
    const existing = db.createTask({ spec: 'Existing task', runId })

    const error = captureError(() =>
      db.createStartingWorkerDispatch({
        taskId: existing.id,
        createTask: { spec: 'Inline worker task', runId },
        startOptions: {}
      })
    )

    expect(error).toMatchObject({ name: 'OrchestrationError', code: 'invalid_argument' })
  })

  it('rejects an acceptance carrying neither taskId nor createTask', () => {
    const error = captureError(() => db.createStartingWorkerDispatch({ startOptions: {} }))

    expect(error).toMatchObject({ name: 'OrchestrationError', code: 'invalid_argument' })
  })

  it('still resolves an existing task by id', async () => {
    const existing = db.createTask({ spec: 'Existing task', runId })

    const result = await startWorker({ task: existing.id, spec: undefined })

    expect(result.state).toBe('ready')
    expect(result.taskId).toBe(existing.id)
  })

  it.each<[string, Record<string, unknown>]>([
    ['both task and spec', { task: 'task_x', spec: 'Inline worker task' }],
    ['neither task nor spec', { spec: undefined }],
    ['taskTitle without spec', { task: 'task_x', spec: undefined, taskTitle: 'Inline title' }],
    ['retryOf with spec', { retryOf: 'ctx_x' }]
  ])('rejects %s at the schema boundary', (_case, overrides) => {
    const method = workerStartMethod()
    expect(() =>
      method.params!.parse({
        spec: 'Inline worker task',
        from: 'term_coord',
        worktree: 'current',
        agent: 'codex',
        ...overrides
      })
    ).toThrow()
  })
})
