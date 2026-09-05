import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_METHODS } from './orchestration'
import type { RpcContext } from '../core'
import { OrchestrationDb } from '../../orchestration/db'
import { OrcaRuntimeService } from '../../orca-runtime'

describe('orchestration worker release incarnation fallback', () => {
  let db: OrchestrationDb
  let dbOpen = false
  let runtime: OrcaRuntimeService
  let ctx: RpcContext
  let activeRunId: string
  let inspectProcessLiveness: ReturnType<typeof vi.fn>

  const coordinatorPaneKey = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const workerPaneKey = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

  function setup(): void {
    db = new OrchestrationDb(':memory:')
    dbOpen = true
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    inspectProcessLiveness = vi.fn().mockResolvedValue('live')
    ;(
      runtime as unknown as {
        inspectTerminalProcessIncarnationLiveness: typeof inspectProcessLiveness
      }
    ).inspectTerminalProcessIncarnationLiveness = inspectProcessLiveness
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord'
        ? coordinatorPaneKey
        : handle === 'term_worker' || handle === 'term_reminted'
          ? workerPaneKey
          : null
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
      handle === 'term_worker' || handle === 'term_reminted' ? 'runtime_test:term_worker:1' : null
    )
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) =>
      handle === 'term_worker' || handle === 'term_reminted'
        ? ({
            terminalHandle: handle,
            paneKey: workerPaneKey,
            processIncarnation: 'runtime_test:term_worker:1',
            hostScope: { kind: 'local', hostId: 'local' }
          } as never)
        : null
    )
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(runtime, 'showTerminal').mockImplementation(
      async (handle) => ({ handle, worktreeId: 'repo::worktree', status: 'running' }) as never
    )
    vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
      id: 'repo::worktree'
    } as never)
    vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
      handle: 'term_worker',
      worktreeId: 'repo::worktree',
      title: 'worker'
    })
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
    vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(true)
    vi.spyOn(runtime, 'getExactWorkerProviderSession').mockReturnValue(null)
    vi.spyOn(runtime, 'readTerminal').mockResolvedValue({
      handle: 'term_worker',
      status: 'running',
      tail: ['worker output line 1', 'worker output line 2'],
      truncated: false,
      nextCursor: '2'
    })
    vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({
      handle: 'term_worker',
      tabId: 'tab-worker',
      ptyKilled: true
    } as never)
    vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
    activeRunId = db.createRun({
      objective: 'Release test Run',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey
    }).id
    ctx = { runtime }
  }

  afterEach(() => {
    if (dbOpen) {
      dbOpen = false
      db.close()
    }
    vi.restoreAllMocks()
  })

  function findMethod(name: string) {
    const method = ORCHESTRATION_METHODS.find((m) => m.name === name)
    if (!method) {
      throw new Error(`Method not found: ${name}`)
    }
    return method
  }

  async function call(name: string, params: Record<string, unknown>) {
    const method = findMethod(name)
    const parsed = method.params ? method.params.parse(params) : undefined
    return method.handler(parsed, ctx)
  }

  async function startWorker(options: { terminal?: string } = {}): Promise<{
    taskId: string
    dispatchId: string
  }> {
    const task = db.createTask({ spec: 'release fixture task', runId: activeRunId })
    const result = (await call('orchestration.workerStart', {
      task: task.id,
      from: 'term_coord',
      ...(options.terminal ? { terminal: options.terminal } : { agent: 'codex' })
    })) as { dispatchId: string; state: string }
    expect(result.state).toBe('ready')
    return { taskId: task.id, dispatchId: result.dispatchId }
  }

  function settle(taskId: string, dispatchId: string, outcome: 'succeeded' | 'failed'): void {
    const settlement = db.settleWorkerReport({
      taskId,
      dispatchId,
      outcome,
      result: `worker ${outcome}`
    })
    expect(settlement.action).toBe('settled')
  }

  async function startSettledWorker(
    outcome: 'succeeded' | 'failed' = 'succeeded',
    options: { terminal?: string } = {}
  ): Promise<{ taskId: string; dispatchId: string }> {
    const worker = await startWorker(options)
    settle(worker.taskId, worker.dispatchId, outcome)
    return worker
  }

  it('closes a live worker terminal whose durable handle no longer resolves but whose process incarnation still matches', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    // The durable handle stops resolving (renderer graph epoch bump / handle invalidation)...
    vi.mocked(runtime.showTerminal).mockImplementation(async (handle) =>
      handle === 'term_worker'
        ? Promise.reject(new Error('terminal_handle_stale'))
        : ({ handle, worktreeId: 'repo::worktree', status: 'running' } as never)
    )
    // ...but the recorded process incarnation still names a live PTY, re-minted to a fresh handle.
    const resolveByIncarnation = vi.fn().mockReturnValue('term_reminted')
    ;(
      runtime as unknown as {
        resolveTerminalHandleByProcessIncarnation: typeof resolveByIncarnation
      }
    ).resolveTerminalHandleByProcessIncarnation = resolveByIncarnation

    const receipt = (await call('orchestration.workerRelease', { dispatch: dispatchId })) as {
      state: string
      processAction: string
    }

    expect(receipt).toMatchObject({ state: 'released', processAction: 'closed_agent_terminal' })
    expect(resolveByIncarnation).toHaveBeenCalledWith(
      'runtime_test:term_worker:1',
      JSON.stringify({ kind: 'local', hostId: 'local' })
    )
    // The close targeted exactly the re-minted live handle for that PTY, never the stale one.
    expect(runtime.closeTerminal).toHaveBeenCalledTimes(1)
    expect(runtime.closeTerminal).toHaveBeenCalledWith('term_reminted')
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      ownership_state: 'released',
      release_state: 'released'
    })
  })

  it('stays release_unknown and closes nothing when the recorded incarnation no longer matches a live pty', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    vi.mocked(runtime.showTerminal).mockRejectedValue(new Error('terminal_handle_stale'))
    // A reused ptyId now belongs to a different process: the incarnation mismatch refuses a close.
    const resolveByIncarnation = vi.fn().mockReturnValue(null)
    ;(
      runtime as unknown as {
        resolveTerminalHandleByProcessIncarnation: typeof resolveByIncarnation
      }
    ).resolveTerminalHandleByProcessIncarnation = resolveByIncarnation

    const receipt = (await call('orchestration.workerRelease', { dispatch: dispatchId })) as {
      state: string
    }

    expect(receipt.state).toBe('release_unknown')
    expect(resolveByIncarnation).toHaveBeenCalledWith(
      'runtime_test:term_worker:1',
      JSON.stringify({ kind: 'local', hostId: 'local' })
    )
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('unknown')
  })

  it('settles released without a close when re-resolution fails but the recorded incarnation is provably gone', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    vi.mocked(runtime.showTerminal).mockRejectedValue(new Error('terminal_handle_stale'))
    const resolveByIncarnation = vi.fn().mockReturnValue(null)
    ;(
      runtime as unknown as {
        resolveTerminalHandleByProcessIncarnation: typeof resolveByIncarnation
      }
    ).resolveTerminalHandleByProcessIncarnation = resolveByIncarnation
    inspectProcessLiveness.mockResolvedValue('exited')

    const receipt = (await call('orchestration.workerRelease', { dispatch: dispatchId })) as {
      state: string
      processAction: string
    }

    expect(receipt).toMatchObject({ state: 'released', processAction: 'none' })
    expect(inspectProcessLiveness).toHaveBeenCalledWith(
      'runtime_test:term_worker:1',
      JSON.stringify({ kind: 'local', hostId: 'local' })
    )
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      ownership_state: 'released',
      release_state: 'released'
    })
  })

  it('settles released before the lease check when a gone worker is provably exited with no live authority', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    // The durable handle no longer resolves and no live PTY carries the recorded incarnation, so
    // inspectWorkerTerminal reports status 'missing' with a null handle.
    vi.mocked(runtime.showTerminal).mockRejectedValue(new Error('terminal_handle_stale'))
    const resolveByIncarnation = vi.fn().mockReturnValue(null)
    ;(
      runtime as unknown as {
        resolveTerminalHandleByProcessIncarnation: typeof resolveByIncarnation
      }
    ).resolveTerminalHandleByProcessIncarnation = resolveByIncarnation
    // No live authority backs the stale durable handle: the lease check cannot prove the lease
    // current and must not pre-empt the missing-branch disposition of a provably gone worker.
    vi.mocked(runtime.getOrchestrationDispatchAuthority).mockReturnValue(null)
    inspectProcessLiveness.mockResolvedValue('exited')

    const receipt = (await call('orchestration.workerRelease', { dispatch: dispatchId })) as {
      state: string
      processAction: string
    }

    expect(receipt).toMatchObject({ state: 'released', processAction: 'none' })
    expect(receipt.state).not.toBe('retained')
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      ownership_state: 'released',
      release_state: 'released'
    })
  })

  it('concedes release_unknown before the lease check when a gone worker has no live authority and liveness is unproven', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    vi.mocked(runtime.showTerminal).mockRejectedValue(new Error('terminal_handle_stale'))
    const resolveByIncarnation = vi.fn().mockReturnValue(null)
    ;(
      runtime as unknown as {
        resolveTerminalHandleByProcessIncarnation: typeof resolveByIncarnation
      }
    ).resolveTerminalHandleByProcessIncarnation = resolveByIncarnation
    vi.mocked(runtime.getOrchestrationDispatchAuthority).mockReturnValue(null)
    // Liveness is unresolvable/not-exited: the process may have been re-homed, so concede rather
    // than retain or guess at a live process.
    inspectProcessLiveness.mockResolvedValue('live')

    const receipt = (await call('orchestration.workerRelease', { dispatch: dispatchId })) as {
      state: string
    }

    expect(receipt.state).toBe('release_unknown')
    expect(receipt.state).not.toBe('retained')
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('unknown')
  })

  it('workerStop closes a live worker via the reminted handle when the durable handle is stale', async () => {
    setup()
    const { dispatchId } = await startWorker()
    // The durable handle stops resolving, but the recorded incarnation still names a live PTY.
    vi.mocked(runtime.showTerminal).mockImplementation(async (handle) =>
      handle === 'term_worker'
        ? Promise.reject(new Error('terminal_handle_stale'))
        : ({ handle, worktreeId: 'repo::worktree', status: 'running' } as never)
    )
    const resolveByIncarnation = vi.fn().mockReturnValue('term_reminted')
    ;(
      runtime as unknown as {
        resolveTerminalHandleByProcessIncarnation: typeof resolveByIncarnation
      }
    ).resolveTerminalHandleByProcessIncarnation = resolveByIncarnation

    const receipt = (await call('orchestration.workerStop', { dispatch: dispatchId })) as {
      processAction: string
    }

    expect(receipt.processAction).toBe('closed_agent_terminal')
    // The kill targeted exactly the reminted live handle, never the stale durable one — closing
    // the stale handle would throw terminal_handle_stale and leak the PTY.
    expect(runtime.closeTerminal).toHaveBeenCalledTimes(1)
    expect(runtime.closeTerminal).toHaveBeenCalledWith('term_reminted')
  })

  it('workerRead reads a live worker via the reminted handle when the durable handle is stale', async () => {
    setup()
    const { dispatchId } = await startWorker()
    vi.mocked(runtime.showTerminal).mockImplementation(async (handle) =>
      handle === 'term_worker'
        ? Promise.reject(new Error('terminal_handle_stale'))
        : ({ handle, worktreeId: 'repo::worktree', status: 'running' } as never)
    )
    const resolveByIncarnation = vi.fn().mockReturnValue('term_reminted')
    ;(
      runtime as unknown as {
        resolveTerminalHandleByProcessIncarnation: typeof resolveByIncarnation
      }
    ).resolveTerminalHandleByProcessIncarnation = resolveByIncarnation

    const output = (await call('orchestration.workerRead', { dispatch: dispatchId })) as {
      terminal?: { tail: string[] }
    }

    // Both the exact-session probe and the terminal read addressed the reminted handle.
    expect(runtime.getExactWorkerProviderSession).toHaveBeenCalledWith(
      'term_reminted',
      expect.any(Number)
    )
    expect(runtime.readTerminal).toHaveBeenCalledWith('term_reminted', expect.anything())
    expect(output.terminal?.tail).toEqual(['worker output line 1', 'worker output line 2'])
  })
})
