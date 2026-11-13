import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../../../../../shared/orchestration/orchestration-runtime-capabilities'
import { OrcaRuntimeService } from '../../../../../../orca-runtime'
import { OrchestrationDb } from '../../../../../../orchestration/db/orchestration-db'
import '../../../../../../orchestration/db/contract-constants'
import '../../../../../../orchestration/db/messages/mailbox-routing-page'
import '../../../../../../orchestration/db/dispatch-row-writer'
import '../../../../../../orchestration/db/attempt-outcome-projection'
import { RpcDispatcher } from '../../../../../dispatcher'
import type { RpcRequest } from '../../../../../core'
import { ORCHESTRATION_METHODS } from '../../../orchestration'
import '../launch/worker-opencode-model-preflight'
import '../../../../../../../../shared/rpc-contract/orchestration-federation-start-params'

describe('orchestration new-worktree workers', () => {
  const coordinatorPaneKey = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let runId: string
  const paths: string[] = []

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

  afterEach(() => {
    db.close()
    for (const path of paths.splice(0)) {
      rmSync(path, { recursive: true, force: true })
    }
  })

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

  // Composer and idle readiness paths must both record setup evidence; the composer path previously dropped it.

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

  it('returns outcome unknown when worktree creation may have been accepted remotely', async () => {
    vi.spyOn(runtime, 'createManagedWorktree').mockRejectedValue(
      Object.assign(new Error('connection closed after request acceptance'), {
        code: 'operation_unknown'
      })
    )

    const { result, task } = await startWorker()

    expect(result).toMatchObject({
      state: 'outcome_unknown',
      failedStage: 'worktree_create'
    })
    expect(db.getTask(task.id)?.status).toBe('blocked')
  })

  it('replays a dispatch-input failure after restart without creating another worker', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-worker-start-replay-'))
    paths.push(dir)
    db.close()
    db = new OrchestrationDb(join(dir, 'orchestration.db'))
    runtime.setOrchestrationDb(db)
    runId = db.createRun({
      objective: 'Recover dispatch input',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey
    }).id
    mockCreatedWorktree({ hookFound: false })
    vi.mocked(runtime.sendTerminalAgentPrompt).mockRejectedValueOnce(
      new Error('connection closed before dispatch input was accepted')
    )
    const task = db.createTask({ spec: 'recover dispatch input', runId })
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
        name: 'recover-input-worker',
        agent: 'codex'
      }
    }

    const first = await dispatcher.dispatch(request)
    if (!first.ok) {
      throw new Error(`Initial worker start failed: ${first.error.code}`)
    }
    const firstReceipt = first.result as {
      dispatchId: string
      residualResources: unknown[]
    }
    db.close()

    db = new OrchestrationDb(join(dir, 'orchestration.db'))
    const restartedRuntime = new OrcaRuntimeService()
    restartedRuntime.setOrchestrationDb(db)
    vi.spyOn(restartedRuntime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord_reminted'
        ? `tab_coord_reminted:${coordinatorPaneKey.split(':')[1]}`
        : null
    )
    const recreateWorktree = vi
      .spyOn(restartedRuntime, 'createManagedWorktree')
      .mockRejectedValue(new Error('replay recreated the worktree'))
    const reinjectPrompt = vi
      .spyOn(restartedRuntime, 'sendTerminalAgentPrompt')
      .mockRejectedValue(new Error('replay reinjected the prompt'))
    const restartedDispatcher = new RpcDispatcher({
      runtime: restartedRuntime,
      methods: ORCHESTRATION_METHODS
    })
    const replay = await restartedDispatcher.dispatch({
      ...request,
      id: 'rpc_worker_start_retry',
      authToken: 'caller-token-after-restart',
      params: { ...(request.params as Record<string, unknown>), from: 'term_coord_reminted' }
    })

    expect(first).toMatchObject({
      ok: true,
      result: {
        state: 'failed',
        failedStage: 'dispatch_input',
        residualResources: expect.arrayContaining([
          expect.objectContaining({ kind: 'worktree', id: 'repo::created' }),
          expect.objectContaining({ kind: 'terminal', id: 'term_worker' })
        ]),
        mutation: { requestId: 'worker_start_request', replayed: false }
      }
    })
    expect(replay).toMatchObject({
      ok: true,
      result: {
        dispatchId: firstReceipt.dispatchId,
        state: 'failed',
        failedStage: 'dispatch_input',
        residualResources: firstReceipt.residualResources,
        mutation: { requestId: 'worker_start_request', replayed: true }
      }
    })
    expect(recreateWorktree).not.toHaveBeenCalled()
    expect(reinjectPrompt).not.toHaveBeenCalled()
  })
})
