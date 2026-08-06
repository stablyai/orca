import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../shared/protocol-version'
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
    vi.spyOn(runtime, 'showRepo').mockResolvedValue({
      id: 'repo',
      kind: 'git'
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
    vi.spyOn(runtime, 'waitForSetupTerminalCompletion').mockReturnValue(
      new Promise(() => undefined)
    )
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
    setupTerminalHandle?: string
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
        state,
        terminalHandle:
          options?.setupTerminalHandle ??
          options?.terminals?.find((terminal) => terminal.title === 'Setup')?.handle
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
        observeSetupCompletion: true,
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

  it('passes launch preferences into agent-first worktree creation', async () => {
    mockCreatedWorktree()

    const { result } = await startWorker({
      model: 'custom-codex-model',
      effort: 'high'
    })

    expect(runtime.createManagedWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        startupAgent: 'codex',
        startupLaunchPreferences: { model: 'custom-codex-model', effort: 'high' }
      })
    )
    expect(result).toMatchObject({
      state: 'ready',
      launch: {
        requested: { agent: 'codex', model: 'custom-codex-model', effort: 'high' },
        effective: { agent: 'codex', model: 'custom-codex-model', effort: 'high' }
      }
    })
  })

  it('rejects a new worktree for a folder project before creating effects', async () => {
    vi.mocked(runtime.showRepo).mockResolvedValue({
      id: 'repo',
      kind: 'folder'
    } as never)
    const createWorktree = vi.spyOn(runtime, 'createManagedWorktree')
    const task = db.createTask({ spec: 'folder task', runId })
    const method = ORCHESTRATION_METHODS.find(
      (candidate) => candidate.name === 'orchestration.workerStart'
    )
    if (!method) {
      throw new Error('workerStart method is not registered')
    }

    await expect(
      method.handler(
        method.params!.parse({
          task: task.id,
          from: 'term_coord',
          worktree: 'new-child',
          name: 'folder-worker',
          agent: 'codex'
        }),
        { runtime }
      )
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message:
        'Folder projects cannot create orchestration worktrees; use current or an exact existing folder workspace.'
    })
    expect(createWorktree).not.toHaveBeenCalled()
    expect(db.getTask(task.id)?.status).toBe('ready')
    expect(db.getDispatchContext(task.id)).toBeUndefined()
  })

  it('injects the execution host CLI command and Dispatch capability together', async () => {
    mockCreatedWorktree()
    vi.mocked(runtime.getTerminalOrchestrationCliCommand).mockReturnValue('orca-ide')

    await startWorker({ worktree: 'new-top-level' })

    const prompt = vi.mocked(runtime.sendTerminalAgentPrompt).mock.calls[0]?.[1] ?? ''
    expect(prompt).toContain('orca-ide orchestration send')
    expect(prompt).toMatch(/--dispatch-capability dcap_[A-Za-z0-9_-]+/)
    expect(prompt).not.toMatch(/(^|\s)orca orchestration send/)
  })

  it('passes exact repo, base, metadata, lineage, and setup choices to worktree creation', async () => {
    mockCreatedWorktree({ state: 'skipped' })

    await startWorker({
      worktree: 'new-top-level',
      repo: 'id:repo-explicit',
      baseBranch: 'origin/release',
      displayName: 'Windows release audit',
      comment: 'Created for a supervised audit',
      setup: 'skip'
    })

    expect(runtime.createManagedWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        repoSelector: 'id:repo-explicit',
        baseBranch: 'origin/release',
        displayName: 'Windows release audit',
        comment: 'Created for a supervised audit',
        setupDecision: 'skip',
        runHooks: false,
        lineage: expect.objectContaining({ noParent: true, parentWorktree: undefined })
      })
    )
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
      expect.objectContaining({ setupDecision: setup, runHooks: false, activate: false })
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
    let finishSetup: ((result: { exitCode: number | null }) => void) | undefined
    vi.mocked(runtime.waitForSetupTerminalCompletion).mockImplementation(
      async () =>
        await new Promise((resolve) => {
          finishSetup = resolve
        })
    )

    const { result, task } = await startWorker()
    const dispatchId = (result as { dispatchId: string }).dispatchId

    expect(result).toMatchObject({ state: 'ready', setup: { state: 'running' } })
    expect(
      db.settleWorkerReport({
        taskId: task.id,
        dispatchId,
        outcome: 'succeeded',
        result: '{}'
      })
    ).toMatchObject({ action: 'settled' })
    finishSetup?.({ exitCode: 1 })
    await vi.waitFor(() => expect(db.getWorkerDispatch(dispatchId)?.setup_state).toBe('failed'))
    expect(db.getWorkerDispatch(dispatchId)).toMatchObject({
      state: 'succeeded',
      stage: 'settled',
      setup_state: 'failed'
    })
    expect(JSON.parse(db.getWorkerDispatch(dispatchId)?.effects ?? '[]')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'dispatch_input', state: 'accepted' })
      ])
    )
    expect(runtime.sendTerminalAgentPrompt).toHaveBeenCalledOnce()
    expect(db.getInbox(10).filter((message) => message.run_id === runId)).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'status', priority: 'high' })])
    )
  })

  it('uses the exact setup handle instead of a configured tab title', async () => {
    mockCreatedWorktree({
      setupTerminalHandle: 'term_actual_setup',
      terminals: [
        { handle: 'term_worker', title: 'Codex' },
        { handle: 'term_configured_setup', title: 'Setup' },
        { handle: 'term_actual_setup', title: 'PowerShell' }
      ]
    })

    const { result } = await startWorker()

    expect(result).toMatchObject({
      effects: expect.arrayContaining([
        expect.objectContaining({
          kind: 'terminal',
          id: 'term_configured_setup',
          role: 'configured_tab'
        }),
        expect.objectContaining({ kind: 'terminal', id: 'term_actual_setup', role: 'setup' }),
        expect.objectContaining({ kind: 'setup', terminalId: 'term_actual_setup' })
      ])
    })
  })

  it('records wait-for-setup success before task input is accepted', async () => {
    mockCreatedWorktree({ startupPolicy: 'wait-for-setup', state: 'running' })

    const { result } = await startWorker()
    const dispatchId = (result as { dispatchId: string }).dispatchId

    expect(result).toMatchObject({
      state: 'ready',
      setup: { startupPolicy: 'wait-for-setup', state: 'succeeded' },
      effects: expect.arrayContaining([
        expect.objectContaining({ kind: 'setup', state: 'succeeded' }),
        expect.objectContaining({ kind: 'dispatch_input', state: 'accepted' })
      ])
    })
    expect(vi.mocked(runtime.waitForTerminal).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(runtime.sendTerminalAgentPrompt).mock.invocationCallOrder[0]!
    )
    expect(JSON.parse(db.getWorkerDispatch(dispatchId)?.effects ?? '[]')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'dispatch_input', state: 'accepted' })
      ])
    )
  })

  it('does not inject task input when the gated setup terminal fails to start', async () => {
    mockCreatedWorktree({ startupPolicy: 'wait-for-setup', state: 'spawn_failed' })
    vi.mocked(runtime.waitForTerminal).mockResolvedValue({
      handle: 'term_worker',
      condition: 'tui-idle',
      satisfied: false,
      status: 'exited',
      exitCode: 1
    })

    const { result, task } = await startWorker()

    expect(result).toMatchObject({
      state: 'failed',
      failedStage: 'setup_start',
      setup: { startupPolicy: 'wait-for-setup', state: 'spawn_failed' },
      effects: expect.arrayContaining([
        expect.objectContaining({ kind: 'setup', state: 'spawn_failed' })
      ])
    })
    expect(db.getTask(task.id)?.status).toBe('failed')
    expect(runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  it('does not inject task input when the gated setup script fails', async () => {
    mockCreatedWorktree({ startupPolicy: 'wait-for-setup', state: 'running' })
    vi.mocked(runtime.waitForTerminal).mockResolvedValue({
      handle: 'term_worker',
      condition: 'tui-idle',
      satisfied: false,
      status: 'exited',
      exitCode: 1
    })

    const { result } = await startWorker()

    expect(result).toMatchObject({
      state: 'failed',
      failedStage: 'setup_wait',
      setup: { state: 'failed' },
      effects: expect.arrayContaining([expect.objectContaining({ kind: 'setup', state: 'failed' })])
    })
    expect(runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  it('does not mislabel a wait-for-setup timeout as setup failure', async () => {
    mockCreatedWorktree({ startupPolicy: 'wait-for-setup', state: 'running' })
    vi.mocked(runtime.waitForTerminal).mockResolvedValue({
      handle: 'term_worker',
      condition: 'tui-idle',
      satisfied: false,
      status: 'running',
      exitCode: null
    })

    const { result } = await startWorker()

    expect(result).toMatchObject({
      state: 'failed',
      failedStage: 'agent_readiness',
      setup: { state: 'running' }
    })
    expect(runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  it('distinguishes no-effect failure, unknown acceptance, and durable residual effects', async () => {
    vi.spyOn(runtime, 'createManagedWorktree').mockRejectedValueOnce(
      new Error('repository validation failed before creation')
    )
    const noEffect = await startWorker({ name: 'no-effect' })
    expect(noEffect.result).toMatchObject({
      state: 'failed',
      failedStage: 'worktree_create',
      effects: [],
      residualResources: []
    })

    vi.mocked(runtime.createManagedWorktree).mockRejectedValueOnce(
      Object.assign(new Error('connection lost after possible acceptance'), {
        code: 'operation_unknown'
      })
    )
    const unknown = await startWorker({ name: 'unknown-effect' })
    expect(unknown.result).toMatchObject({
      state: 'outcome_unknown',
      failedStage: 'worktree_create',
      effects: [],
      residualResources: []
    })

    mockCreatedWorktree()
    vi.mocked(runtime.waitForTerminal).mockResolvedValueOnce({
      handle: 'term_worker',
      condition: 'tui-idle',
      satisfied: false,
      status: 'exited',
      exitCode: 1
    })
    const durableEffect = await startWorker({ name: 'durable-effect' })
    expect(durableEffect.result).toMatchObject({
      state: 'failed',
      failedStage: 'agent_readiness',
      effects: expect.arrayContaining([
        expect.objectContaining({ kind: 'worktree', id: 'repo::created' }),
        expect.objectContaining({ kind: 'terminal', id: 'term_worker' })
      ]),
      residualResources: expect.arrayContaining([
        expect.objectContaining({ kind: 'worktree', id: 'repo::created' }),
        expect.objectContaining({ kind: 'terminal', id: 'term_worker' })
      ])
    })
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
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
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

  it('persists pre-effect, post-effect, and post-input stages in order', async () => {
    mockCreatedWorktree({ hookFound: false })
    let finishWait:
      | ((value: Awaited<ReturnType<OrcaRuntimeService['waitForTerminal']>>) => void)
      | undefined
    let finishPrompt:
      | ((value: Awaited<ReturnType<OrcaRuntimeService['sendTerminalAgentPrompt']>>) => void)
      | undefined
    vi.mocked(runtime.waitForTerminal).mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          finishWait = resolve
        })
    )
    vi.mocked(runtime.sendTerminalAgentPrompt).mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          finishPrompt = resolve
        })
    )

    const pending = startWorker({ name: 'staged-worker' })
    await vi.waitFor(() => {
      const task = db.listTasks()[0]
      const dispatch = task ? db.getDispatchContext(task.id) : undefined
      expect(dispatch && db.getWorkerDispatch(dispatch.id)).toMatchObject({
        state: 'starting',
        stage: 'terminal_readying',
        worktree_id: 'repo::created',
        agent_terminal_handle: 'term_worker'
      })
    })
    const dispatch = db.getDispatchContext(db.listTasks()[0]!.id)!
    expect(JSON.parse(db.getWorkerDispatch(dispatch.id)!.residual_resources)).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'worktree', id: 'repo::created' })])
    )

    finishWait?.({
      handle: 'term_worker',
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })
    await vi.waitFor(() =>
      expect(db.getWorkerDispatch(dispatch.id)).toMatchObject({
        state: 'starting',
        stage: 'authority_attached'
      })
    )

    finishPrompt?.({ handle: 'term_worker', accepted: true, bytesWritten: 1 })
    await expect(pending).resolves.toMatchObject({
      result: { state: 'ready', stage: 'input_accepted' }
    })
    expect(db.getWorkerDispatch(dispatch.id)).toMatchObject({
      state: 'ready',
      stage: 'input_accepted'
    })
  })
})
