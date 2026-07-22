import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import { ORCHESTRATION_METHODS } from './orchestration'

describe('orchestration new-worktree workers', () => {
  type CreateWorktreeResult = Awaited<ReturnType<OrcaRuntimeService['createManagedWorktree']>>
  const coordinatorPaneKey = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let runId: string

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    runId = db.createRun({
      objective: 'Test new-worktree workers',
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
    vi.spyOn(runtime, 'createTerminal')
    vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
      terminals: [{ handle: 'term_worker', title: 'Codex' }],
      totalCount: 1,
      truncated: false
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

  async function startWorker(overrides: Record<string, unknown> = {}) {
    const task = db.createTask({ spec: 'new-worktree task', runId })
    const method = ORCHESTRATION_METHODS.find(
      (candidate) => candidate.name === 'orchestration.workerStart'
    )
    if (!method) {
      throw new Error('workerStart method is not registered')
    }
    const params = method.params!.parse({
      task: task.id,
      from: 'term_coord',
      worktree: 'new-child',
      name: 'new-worker',
      agent: 'codex',
      ...overrides
    })
    const result = await method.handler(params, { runtime })
    return { result, task }
  }

  function mockCreatedWorktree(options?: {
    hookFound?: boolean
    startupPolicy?: 'start-immediately' | 'wait-for-setup'
    state?: 'running' | 'skipped' | 'not_configured' | 'spawn_failed'
    terminals?: { handle: string; title: string }[]
  }) {
    const hookFound = options?.hookFound ?? true
    const state = options?.state ?? (hookFound ? 'running' : 'not_configured')
    vi.spyOn(runtime, 'createManagedWorktree').mockResolvedValue({
      worktree: { id: 'repo::created', repoId: 'repo' },
      startupTerminal: { spawned: true, handle: 'term_worker' },
      setupReceipt: {
        requested: state === 'skipped' ? 'skip' : 'run',
        hookFound,
        startupPolicy: options?.startupPolicy ?? 'start-immediately',
        state
      }
    } as never)
    if (options?.terminals) {
      vi.mocked(runtime.listTerminals).mockResolvedValue({
        terminals: options.terminals,
        totalCount: options.terminals.length,
        truncated: false
      } as never)
    }
  }

  it('creates an independent top-level worktree and reuses its agent terminal', async () => {
    mockCreatedWorktree()

    const { result } = await startWorker({ worktree: 'new-top-level' })

    expect(runtime.createManagedWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        startupAgent: 'codex',
        awaitTerminalProvisioning: true,
        lineage: expect.objectContaining({ noParent: true, parentWorktree: undefined })
      })
    )
    expect(result).toMatchObject({ state: 'ready' })
    expect(result).toHaveProperty(
      'effects',
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'worktree',
          action: 'created_top_level',
          id: 'repo::created'
        }),
        expect.objectContaining({
          kind: 'terminal',
          role: 'agent',
          action: 'reused_agent_terminal',
          id: 'term_worker'
        })
      ])
    )
    expect(runtime.createTerminal).not.toHaveBeenCalled()
  })

  it('reports an absent setup hook as not configured without failing the start', async () => {
    mockCreatedWorktree({ hookFound: false })

    const { result } = await startWorker()

    expect(result).toMatchObject({
      state: 'ready',
      setup: {
        requested: 'run',
        effective: 'run',
        source: 'orchestration_default',
        hookFound: false,
        state: 'not_configured'
      }
    })
  })

  it.each([
    ['skip', 'skipped'],
    ['inherit', 'not_configured'],
    ['run', 'running']
  ] as const)('passes explicit setup=%s through with a truthful receipt', async (setup, state) => {
    mockCreatedWorktree({ hookFound: setup === 'run', state })

    const { result } = await startWorker({ setup })

    expect(runtime.createManagedWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ setupDecision: setup, runHooks: setup === 'run' })
    )
    expect(result).toMatchObject({
      state: 'ready',
      setup: { requested: setup, effective: setup, source: 'explicit_request', state }
    })
  })

  it('records a later setup failure without gating a start-immediately worker', async () => {
    mockCreatedWorktree({
      terminals: [
        { handle: 'term_worker', title: 'Codex' },
        { handle: 'term_setup', title: 'Setup' }
      ]
    })
    vi.mocked(runtime.waitForTerminal).mockImplementation(async (handle, options) =>
      options?.condition === 'exit'
        ? {
            handle,
            condition: 'exit',
            satisfied: true,
            status: 'exited',
            exitCode: 1
          }
        : {
            handle,
            condition: 'tui-idle',
            satisfied: true,
            status: 'running',
            exitCode: null
          }
    )

    const { result } = await startWorker()
    const dispatchId = (result as { dispatchId: string }).dispatchId

    expect(result).toMatchObject({ state: 'ready', setup: { state: 'running' } })
    await vi.waitFor(() => expect(db.getWorkerDispatch(dispatchId)?.setup_state).toBe('failed'))
    expect(db.getWorkerDispatch(dispatchId)?.state).toBe('ready')
    expect(runtime.sendTerminalAgentPrompt).toHaveBeenCalledOnce()
    expect(db.getInbox(10).filter((message) => message.run_id === runId)).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'status', priority: 'high' })])
    )
  })

  it('does not inject task input when wait-for-setup prevents agent readiness', async () => {
    mockCreatedWorktree({ startupPolicy: 'wait-for-setup', state: 'spawn_failed' })
    vi.mocked(runtime.waitForTerminal).mockResolvedValue({
      handle: 'term_worker',
      condition: 'tui-idle',
      satisfied: false,
      status: 'exited',
      exitCode: 1
    })

    const { result, task } = await startWorker()

    expect(result).toMatchObject({ state: 'failed', failedStage: 'agent_readiness' })
    expect(db.getTask(task.id)?.status).toBe('failed')
    expect(runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  it('returns outcome unknown when worktree creation may have been accepted remotely', async () => {
    vi.spyOn(runtime, 'createManagedWorktree').mockRejectedValue(
      Object.assign(new Error('connection closed after request acceptance'), {
        code: 'operation_unknown'
      })
    )

    const { result, task } = await startWorker()

    expect(result).toMatchObject({
      state: 'outcome_unknown',
      failedStage: 'worktree_create',
      nextCommands: expect.arrayContaining([
        expect.stringContaining('worker-show --dispatch'),
        expect.stringContaining('worker-abandon --dispatch')
      ])
    })
    expect(db.getTask(task.id)?.status).toBe('blocked')
  })

  it('persists the retry request with the starting Dispatch before worktree effects', async () => {
    const task = db.createTask({ spec: 'atomic worker acceptance', runId })
    let finishCreate: ((value: CreateWorktreeResult) => void) | undefined
    vi.spyOn(runtime, 'createManagedWorktree').mockImplementation(
      async () =>
        await new Promise((resolve) => {
          finishCreate = resolve
        })
    )
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
    const request: RpcRequest = {
      id: 'rpc_worker_start',
      authToken: 'caller-token',
      orchestrationRequestId: 'worker_start_request',
      method: 'orchestration.workerStart',
      params: {
        task: task.id,
        from: 'term_coord',
        worktree: 'new-child',
        name: 'atomic-worker',
        agent: 'codex'
      }
    }

    const pending = dispatcher.dispatch(request)
    await vi.waitFor(() => expect(db.getDispatchContext(task.id)).toBeDefined())
    const acceptedDispatch = db.getDispatchContext(task.id)!
    const callerFingerprint = createHash('sha256').update('caller-token').digest('hex')
    const receipt = db.getMutationReceipt(callerFingerprint, 'worker_start_request')

    expect(receipt).toMatchObject({
      request_id: 'worker_start_request',
      method: 'orchestration.workerStart',
      state: 'pending'
    })
    expect(db.getWorkerDispatch(acceptedDispatch.id)).toMatchObject({
      state: 'starting',
      stage: 'worktree_creating'
    })

    finishCreate?.({
      worktree: { id: 'repo::created', repoId: 'repo' },
      startupTerminal: { spawned: true, handle: 'term_worker' },
      setupReceipt: {
        requested: 'run',
        hookFound: false,
        startupPolicy: 'start-immediately',
        state: 'not_configured'
      }
    } as CreateWorktreeResult)
    await expect(pending).resolves.toMatchObject({
      ok: true,
      result: { state: 'ready', mutation: { requestId: 'worker_start_request' } }
    })
    expect(db.getMutationReceipt(callerFingerprint, 'worker_start_request')).toMatchObject({
      state: 'completed'
    })
  })
})
