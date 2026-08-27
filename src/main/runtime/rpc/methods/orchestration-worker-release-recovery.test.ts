import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../orchestration/db'
import { reconcileRequestedWorkerTerminalReleases } from '../../orchestration/worker-terminal-release-reconciliation'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcContext } from '../core'
import { ORCHESTRATION_METHODS } from './orchestration'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

describe('orchestration worker release recovery', () => {
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
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) =>
      handle === 'term_worker'
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
    })
    vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
    activeRunId = db.createRun({
      objective: 'Release recovery test Run',
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

  async function call(name: string, params: Record<string, unknown>) {
    const method = ORCHESTRATION_METHODS.find((candidate) => candidate.name === name)
    if (!method) {
      throw new Error(`Method not found: ${name}`)
    }
    const parsed = method.params ? method.params.parse(params) : undefined
    return method.handler(parsed, ctx)
  }

  async function startWorker(): Promise<{ taskId: string; dispatchId: string }> {
    const task = db.createTask({ spec: 'release recovery fixture task', runId: activeRunId })
    const result = (await call('orchestration.workerStart', {
      task: task.id,
      from: 'term_coord',
      agent: 'codex'
    })) as { dispatchId: string; state: string }
    expect(result.state).toBe('ready')
    return { taskId: task.id, dispatchId: result.dispatchId }
  }

  async function startSettledWorker(
    outcome: 'succeeded' | 'failed' = 'succeeded'
  ): Promise<{ taskId: string; dispatchId: string }> {
    const worker = await startWorker()
    expect(
      db.settleWorkerReport({
        taskId: worker.taskId,
        dispatchId: worker.dispatchId,
        outcome,
        result: `worker ${outcome}`
      }).action
    ).toBe('settled')
    return worker
  }

  it('finishes a requested release after restart-style interruption', async () => {
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

  it('defers instead of settling unknown while inventory is incomplete', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    vi.mocked(runtime.closeTerminal).mockRejectedValueOnce(new Error('Multiplexer disposed'))
    await call('orchestration.workerRelease', { dispatch: dispatchId })
    vi.mocked(runtime.showTerminal).mockRejectedValue(new Error('terminal_handle_stale'))

    const result = await reconcileRequestedWorkerTerminalReleases(runtime)
    expect(result).toMatchObject({ attempted: 1, pending: 1, unknown: 0 })
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('releasing')
  })

  it('preserves archived output when an unconfirmed release retry cannot find the terminal', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    vi.mocked(runtime.closeTerminal).mockResolvedValueOnce({
      handle: 'term_worker',
      tabId: 'tab-worker',
      ptyKilled: false,
      ptyStopVerdict: 'unverifiable',
      ptyStopReason: 'its SSH provider is no longer registered'
    })

    await expect(
      call('orchestration.workerRelease', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'release_unknown' })
    expect(db.getWorkerTerminalArchive(dispatchId)).toBeDefined()

    vi.mocked(runtime.showTerminal).mockRejectedValue(new Error('terminal_handle_stale'))
    await expect(
      call('orchestration.workerRelease', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'release_unknown' })
    const read = (await call('orchestration.workerRead', { dispatch: dispatchId })) as {
      archived?: boolean
      terminal: { tail: string[] }
    }
    expect(read).toMatchObject({
      archived: true,
      terminal: { tail: ['worker output line 1', 'worker output line 2'] }
    })
  })

  it('never touches resources without requested releases', async () => {
    setup()
    await startSettledWorker()
    const result = await reconcileRequestedWorkerTerminalReleases(runtime)
    expect(result.attempted).toBe(0)
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('coalesces overlapping reconciliation passes and closes each resource once', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    expect(db.requestWorkerTerminalRelease(dispatchId).disposition).toBe('requested')
    const pendingClose = deferred<Awaited<ReturnType<OrcaRuntimeService['closeTerminal']>>>()
    vi.mocked(runtime.closeTerminal).mockReturnValue(pendingClose.promise)

    const first = reconcileRequestedWorkerTerminalReleases(runtime)
    await vi.waitFor(() => expect(runtime.closeTerminal).toHaveBeenCalledTimes(1))
    const second = reconcileRequestedWorkerTerminalReleases(runtime)
    expect(second).toBe(first)
    pendingClose.resolve({ handle: 'term_worker', tabId: 'tab-worker', ptyKilled: true })

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ attempted: 1, released: 1 }),
      expect.objectContaining({ attempted: 1, released: 1 })
    ])
    expect(runtime.closeTerminal).toHaveBeenCalledTimes(1)
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
    expect(runtime.closeTerminal).toHaveBeenCalledTimes(50)
  })

  it('backfills legacy terminal resources as retained external evidence', () => {
    setup()
    const insertLegacy = (dispatchId: string, handle: string, paneKey: string | null): void => {
      const task = db.createTask({ spec: `legacy ${dispatchId}`, runId: activeRunId })
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

    for (const ambiguous of ['ctx_unique', 'ctx_shared_a', 'ctx_shared_b', 'ctx_no_identity']) {
      expect(db.getWorkerTerminalResourceByOwner(ambiguous)).toMatchObject({
        ownership_state: 'external',
        release_state: 'retained',
        retained_reason: 'legacy_ambiguous'
      })
    }
  })

  it('backfills a legacy creator plus explicit reuser as ambiguous', () => {
    setup()
    const insertLegacy = (dispatchId: string, action: 'created' | 'reused'): void => {
      const task = db.createTask({ spec: dispatchId, runId: activeRunId })
      const raw = (
        db as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }
      ).db
      raw
        .prepare(
          `INSERT INTO dispatch_contexts (id, run_id, task_id, contract_version, assignee_pane_key, process_incarnation, status)
           VALUES (?, ?, ?, 2, ?, ?, ?)`
        )
        .run(
          dispatchId,
          activeRunId,
          task.id,
          workerPaneKey,
          'runtime_test:term_worker:1',
          action === 'created' ? 'completed' : 'dispatched'
        )
      raw
        .prepare(
          `INSERT INTO worker_dispatches (dispatch_id, state, stage, agent_terminal_handle, residual_resources)
           VALUES (?, ?, 'legacy', 'term_worker', ?)`
        )
        .run(
          dispatchId,
          action === 'created' ? 'succeeded' : 'ready',
          JSON.stringify([{ kind: 'terminal', role: 'agent', action, id: 'term_worker' }])
        )
    }
    insertLegacy('ctx_creator', 'created')
    insertLegacy('ctx_reuser', 'reused')
    ;(
      db as unknown as { backfillWorkerTerminalResources: () => void }
    ).backfillWorkerTerminalResources()

    for (const dispatchId of ['ctx_creator', 'ctx_reuser']) {
      expect(db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
        ownership_state: 'external',
        release_state: 'retained',
        retained_reason: 'legacy_ambiguous'
      })
    }
  })

  it('removes terminal authority and archived output on orchestration reset', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    await call('orchestration.workerRelease', { dispatch: dispatchId })
    expect(db.getWorkerTerminalArchive(dispatchId)).toBeDefined()

    db.resetTasks()

    expect(db.getWorkerTerminalResourceByOwner(dispatchId)).toBeUndefined()
    expect(db.getWorkerTerminalArchive(dispatchId)).toBeUndefined()
  })
})
