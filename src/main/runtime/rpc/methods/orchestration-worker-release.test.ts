import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_METHODS } from './orchestration'
import type { RpcContext } from '../core'
import { OrchestrationDb } from '../../orchestration/db'
import { OrcaRuntimeService } from '../../orca-runtime'
import { reconcileRequestedWorkerTerminalReleases } from '../../orchestration/worker-terminal-release-reconciliation'

describe('orchestration worker release', () => {
  let db: OrchestrationDb
  let dbOpen = false
  let runtime: OrcaRuntimeService
  let ctx: RpcContext
  let activeRunId: string

  const coordinatorPaneKey = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const workerPaneKey = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

  function setup(): void {
    db = new OrchestrationDb(':memory:')
    dbOpen = true
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord' ? coordinatorPaneKey : handle === 'term_worker' ? workerPaneKey : null
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
      handle === 'term_worker' ? 'runtime_test:term_worker:1' : null
    )
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(runtime, 'showTerminal').mockImplementation(
      async (handle) => ({ handle, worktreeId: 'repo::worktree', status: 'running' }) as never
    )
    vi.spyOn(runtime, 'showManagedWorktree').mockResolvedValue({
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
      closed: true
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

  it('creates an owned resource for a fresh worker terminal', async () => {
    setup()
    const { dispatchId } = await startWorker()
    const resource = db.getWorkerTerminalResourceByOwner(dispatchId)
    expect(resource).toMatchObject({
      ownership_state: 'owned',
      release_state: 'not_requested',
      terminal_handle: 'term_worker',
      pane_key: workerPaneKey,
      process_incarnation: 'runtime_test:term_worker:1'
    })
  })

  it('releases a succeeded worker: archives then closes exactly the agent terminal', async () => {
    setup()
    const { dispatchId } = await startSettledWorker('succeeded')

    const receipt = (await call('orchestration.workerRelease', { dispatch: dispatchId })) as {
      state: string
      processAction: string
      archive: { source: string | null; status: string | null } | null
    }

    expect(receipt).toMatchObject({
      state: 'released',
      processAction: 'closed_agent_terminal',
      archive: { source: 'terminal', status: 'captured' }
    })
    expect(runtime.closeTerminal).toHaveBeenCalledTimes(1)
    expect(runtime.closeTerminal).toHaveBeenCalledWith('term_worker')
    const resource = db.getWorkerTerminalResourceByOwner(dispatchId)
    expect(resource?.release_state).toBe('released')
    expect(resource?.ownership_state).toBe('released')
    // Outcome is untouched by release.
    expect(db.getWorkerDispatch(dispatchId)?.state).toBe('succeeded')
  })

  it('releases a failed worker the same way', async () => {
    setup()
    const { dispatchId } = await startSettledWorker('failed')
    const receipt = (await call('orchestration.workerRelease', { dispatch: dispatchId })) as {
      state: string
    }
    expect(receipt.state).toBe('released')
    expect(db.getWorkerDispatch(dispatchId)?.state).toBe('failed')
  })

  it('is idempotent: a duplicate release returns already_released without another close', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    await call('orchestration.workerRelease', { dispatch: dispatchId })
    const second = (await call('orchestration.workerRelease', { dispatch: dispatchId })) as {
      state: string
      processAction: string
    }
    expect(second).toMatchObject({ state: 'already_released', processAction: 'none' })
    expect(runtime.closeTerminal).toHaveBeenCalledTimes(1)
  })

  it('rejects an active worker without recording release intent', async () => {
    setup()
    const { dispatchId } = await startWorker()
    await expect(call('orchestration.workerRelease', { dispatch: dispatchId })).rejects.toThrow(
      /only a succeeded or failed worker can release/
    )
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('not_requested')
  })

  it('retains an explicitly reused external terminal without closing it', async () => {
    setup()
    const { dispatchId } = await startSettledWorker('succeeded', { terminal: 'term_worker' })
    const receipt = (await call('orchestration.workerRelease', { dispatch: dispatchId })) as {
      state: string
      reason?: string
    }
    expect(receipt).toMatchObject({ state: 'retained', reason: 'external_terminal' })
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('retains a user-taken-over terminal durably', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    const changed = (await call('orchestration.workerTerminalUserInput', {
      paneKey: workerPaneKey
    })) as { changed: number }
    expect(changed.changed).toBe(1)
    const receipt = (await call('orchestration.workerRelease', { dispatch: dispatchId })) as {
      state: string
      reason?: string
    }
    expect(receipt).toMatchObject({ state: 'retained', reason: 'user_takeover' })
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.ownership_state).toBe('user_owned')
  })

  it('never marks takeover for panes without an owned resource', async () => {
    setup()
    const changed = (await call('orchestration.workerTerminalUserInput', {
      paneKey: 'tab_other:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    })) as { changed: number }
    expect(changed.changed).toBe(0)
  })

  it('retains when the exact process identity changed instead of closing', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    vi.mocked(runtime.getTerminalProcessIncarnation).mockImplementation((handle) =>
      handle === 'term_worker' ? 'runtime_test:term_worker:2' : null
    )
    const receipt = (await call('orchestration.workerRelease', { dispatch: dispatchId })) as {
      state: string
      reason?: string
    }
    expect(receipt).toMatchObject({ state: 'retained', reason: 'identity_unproven' })
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('returns release_unknown when the terminal no longer resolves, then completes a retry', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    vi.mocked(runtime.showTerminal).mockRejectedValue(new Error('terminal_handle_stale'))
    const receipt = (await call('orchestration.workerRelease', { dispatch: dispatchId })) as {
      state: string
      recovery?: string
    }
    expect(receipt.state).toBe('release_unknown')
    expect(receipt.recovery).toContain('worker-show')
    expect(runtime.closeTerminal).not.toHaveBeenCalled()

    vi.mocked(runtime.showTerminal).mockImplementation(
      async (handle) => ({ handle, worktreeId: 'repo::worktree', status: 'running' }) as never
    )
    const retry = (await call('orchestration.workerRelease', { dispatch: dispatchId })) as {
      state: string
    }
    expect(retry.state).toBe('released')
    expect(runtime.closeTerminal).toHaveBeenCalledTimes(1)
  })

  it('retains the live terminal when output capture fails', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    vi.mocked(runtime.readTerminal).mockRejectedValue(new Error('read exploded'))
    await expect(call('orchestration.workerRelease', { dispatch: dispatchId })).rejects.toThrow(
      /Output could not be preserved/
    )
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
    // Durable intent survives for recovery.
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('requested')
  })

  it('marks release_unknown when the close itself fails', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    vi.mocked(runtime.closeTerminal).mockRejectedValue(new Error('close exploded'))
    const receipt = (await call('orchestration.workerRelease', { dispatch: dispatchId })) as {
      state: string
      lastError?: string
    }
    expect(receipt.state).toBe('release_unknown')
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('unknown')
  })

  it('records an explicitly empty archive for an already-exited worker process', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    vi.mocked(runtime.showTerminal).mockImplementation(
      async (handle) => ({ handle, worktreeId: 'repo::worktree', connected: false }) as never
    )
    vi.mocked(runtime.readTerminal).mockResolvedValue({
      handle: 'term_worker',
      status: 'exited',
      tail: [],
      truncated: false,
      nextCursor: null
    })
    const receipt = (await call('orchestration.workerRelease', { dispatch: dispatchId })) as {
      state: string
      processAction: string
      archive: { status: string | null } | null
    }
    expect(receipt).toMatchObject({
      state: 'released',
      processAction: 'closed_exited_terminal',
      archive: { status: 'empty' }
    })
  })

  it('serves the frozen redacted archive through worker-read after release, with cursors', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    vi.mocked(runtime.readTerminal).mockResolvedValue({
      handle: 'term_worker',
      status: 'running',
      tail: ['first line', `capability dcap_${'a'.repeat(24)} leaked`, 'last line'],
      truncated: false,
      nextCursor: '3'
    })
    await call('orchestration.workerRelease', { dispatch: dispatchId })
    vi.mocked(runtime.readTerminal).mockClear()

    const page1 = (await call('orchestration.workerRead', {
      dispatch: dispatchId,
      limit: 2
    })) as { archived?: boolean; terminal: { tail: string[] }; cursor: string | null }
    expect(page1.archived).toBe(true)
    expect(page1.terminal.tail).toEqual([
      'first line',
      'capability [dispatch capability redacted] leaked'
    ])
    expect(page1.cursor).not.toBeNull()

    const page2 = (await call('orchestration.workerRead', {
      dispatch: dispatchId,
      cursor: page1.cursor as string
    })) as { terminal: { tail: string[] }; cursor: string | null }
    expect(page2.terminal.tail).toEqual(['last line'])
    expect(page2.cursor).toBeNull()
    // The live terminal is never consulted after release.
    expect(runtime.readTerminal).not.toHaveBeenCalled()
  })

  it('transfers ownership on exact reuse and fences release through the old Dispatch', async () => {
    setup()
    const first = await startSettledWorker('succeeded')
    const originalResource = db.getWorkerTerminalResourceByOwner(first.dispatchId)
    expect(originalResource?.ownership_state).toBe('owned')

    const second = await startWorker({ terminal: 'term_worker' })
    const transferred = db.getWorkerTerminalResourceByOwner(second.dispatchId)
    expect(transferred?.id).toBe(originalResource?.id)
    expect(db.getWorkerTerminalResourceByOwner(first.dispatchId)).toBeUndefined()

    const oldRelease = (await call('orchestration.workerRelease', {
      dispatch: first.dispatchId
    })) as { state: string; reason?: string }
    expect(oldRelease).toMatchObject({ state: 'retained', reason: 'ownership_transferred' })
    expect(runtime.closeTerminal).not.toHaveBeenCalled()

    settle(second.taskId, second.dispatchId, 'succeeded')
    const newRelease = (await call('orchestration.workerRelease', {
      dispatch: second.dispatchId
    })) as { state: string }
    expect(newRelease.state).toBe('released')
    expect(runtime.closeTerminal).toHaveBeenCalledTimes(1)
  })

  it('worker-retain records a durable user exception that release can later replace', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    const retained = (await call('orchestration.workerRetain', { dispatch: dispatchId })) as {
      state: string
      reason?: string
    }
    expect(retained).toMatchObject({ state: 'retained', reason: 'user_requested' })
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('retained')

    const release = (await call('orchestration.workerRelease', { dispatch: dispatchId })) as {
      state: string
    }
    expect(release.state).toBe('released')
  })

  it('worker-list separates terminal accounting from Task outcome', async () => {
    setup()
    const active = await startWorker()
    const result1 = (await call('orchestration.workerList', { run: activeRunId })) as {
      workers: { dispatchId: string; terminalState: string | null; workerState: string }[]
      counts: Record<string, number>
    }
    expect(result1.workers).toHaveLength(1)
    expect(result1.workers[0]).toMatchObject({
      dispatchId: active.dispatchId,
      terminalState: 'active',
      workerState: 'ready'
    })

    settle(active.taskId, active.dispatchId, 'succeeded')
    const result2 = (await call('orchestration.workerList', {
      run: activeRunId,
      terminalState: 'reclaimable'
    })) as { workers: { dispatchId: string }[]; counts: Record<string, number> }
    expect(result2.workers.map((worker) => worker.dispatchId)).toEqual([active.dispatchId])
    expect(result2.counts).toMatchObject({ reclaimable: 1 })

    await call('orchestration.workerRelease', { dispatch: active.dispatchId })
    const result3 = (await call('orchestration.workerList', { run: activeRunId })) as {
      workers: { terminalState: string | null; workerState: string }[]
    }
    expect(result3.workers[0]).toMatchObject({
      terminalState: 'released',
      workerState: 'succeeded'
    })
  })

  it('worker-show exposes the terminal resource', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    const shown = (await call('orchestration.workerShow', { dispatch: dispatchId })) as {
      terminalResource: { ownershipState: string; releaseState: string } | null
    }
    expect(shown.terminalResource).toMatchObject({
      ownershipState: 'owned',
      releaseState: 'not_requested'
    })
  })

  it('reconciler finishes a requested release after restart-style interruption', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    vi.mocked(runtime.closeTerminal).mockRejectedValueOnce(new Error('Multiplexer disposed'))
    const interrupted = (await call('orchestration.workerRelease', { dispatch: dispatchId })) as {
      state: string
    }
    expect(interrupted.state).toBe('release_pending')
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('releasing')

    const result = await reconcileRequestedWorkerTerminalReleases(runtime)
    expect(result).toMatchObject({ attempted: 1, released: 1 })
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('released')
    expect(runtime.closeTerminal).toHaveBeenCalledTimes(2)
  })

  it('reconciler defers instead of settling unknown while inventory is incomplete', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    vi.mocked(runtime.closeTerminal).mockRejectedValueOnce(new Error('Multiplexer disposed'))
    await call('orchestration.workerRelease', { dispatch: dispatchId })
    vi.mocked(runtime.showTerminal).mockRejectedValue(new Error('terminal_handle_stale'))

    const result = await reconcileRequestedWorkerTerminalReleases(runtime)
    expect(result).toMatchObject({ attempted: 1, pending: 1, unknown: 0 })
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('releasing')
  })

  it('reconciler never touches resources without requested releases', async () => {
    setup()
    await startSettledWorker()
    const result = await reconcileRequestedWorkerTerminalReleases(runtime)
    expect(result.attempted).toBe(0)
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('keeps live terminals bounded across 50 settled workers while controls survive', async () => {
    setup()
    for (let wave = 0; wave < 50; wave += 1) {
      const worker = await startSettledWorker(wave % 2 === 0 ? 'succeeded' : 'failed')
      const receipt = (await call('orchestration.workerRelease', {
        dispatch: worker.dispatchId
      })) as { state: string }
      expect(receipt.state).toBe('released')
    }
    expect(runtime.closeTerminal).toHaveBeenCalledTimes(50)

    const control = await startWorker()
    const listed = (await call('orchestration.workerList', { run: activeRunId })) as {
      workers: { dispatchId: string; terminalState: string | null }[]
      counts: Record<string, number>
    }
    expect(listed.counts).toMatchObject({ released: 50, active: 1 })
    expect(
      listed.workers.find((worker) => worker.dispatchId === control.dispatchId)?.terminalState
    ).toBe('active')
    // The still-working control terminal was never closed.
    expect(runtime.closeTerminal).toHaveBeenCalledTimes(50)
  })

  it('backfills owned resources only for unique exact legacy claims', () => {
    setup()
    const insertLegacy = (dispatchId: string, handle: string, paneKey: string | null): void => {
      db.createTask({ spec: `legacy ${dispatchId}`, runId: activeRunId })
      const task = db
        .listTasks({ runId: activeRunId })
        .find((candidate) => candidate.spec === `legacy ${dispatchId}`)
      if (!task) {
        throw new Error('legacy task missing')
      }
      const raw = (
        db as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }
      ).db
      raw
        .prepare(
          `INSERT INTO dispatch_contexts (id, run_id, task_id, contract_version, assignee_pane_key, process_incarnation, status)
           VALUES (?, ?, ?, 2, ?, ?, 'completed')`
        )
        .run(dispatchId, activeRunId, task.id, paneKey, paneKey ? `inc:${dispatchId}` : null)
      raw
        .prepare(
          `INSERT INTO worker_dispatches (dispatch_id, state, stage, agent_terminal_handle, residual_resources)
           VALUES (?, 'succeeded', 'settled', ?, ?)`
        )
        .run(
          dispatchId,
          handle,
          JSON.stringify([{ kind: 'terminal', role: 'agent', action: 'created', id: handle }])
        )
    }
    insertLegacy('ctx_unique', 'term_unique', 'tab_u:leaf_u')
    insertLegacy('ctx_shared_a', 'term_shared', 'tab_s:leaf_s')
    insertLegacy('ctx_shared_b', 'term_shared', 'tab_s:leaf_s')
    insertLegacy('ctx_no_identity', 'term_bare', null)
    ;(
      db as unknown as { backfillWorkerTerminalResources: () => void }
    ).backfillWorkerTerminalResources()

    expect(db.getWorkerTerminalResourceByOwner('ctx_unique')).toMatchObject({
      ownership_state: 'owned',
      release_state: 'not_requested'
    })
    for (const ambiguous of ['ctx_shared_a', 'ctx_shared_b', 'ctx_no_identity']) {
      expect(db.getWorkerTerminalResourceByOwner(ambiguous)).toMatchObject({
        ownership_state: 'external',
        release_state: 'retained',
        retained_reason: 'legacy_ambiguous'
      })
    }
  })
})
