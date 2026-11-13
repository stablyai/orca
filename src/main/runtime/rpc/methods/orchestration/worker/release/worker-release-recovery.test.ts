import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../../../../orchestration/db/orchestration-db'
import '../../../../../orchestration/db/contract-constants'
import '../../../../../orchestration/db/messages/mailbox-routing-page'
import '../../../../../orchestration/db/dispatch-row-writer'
import '../../../../../orchestration/db/attempt-outcome-projection'
import { reconcileRequestedWorkerTerminalReleases } from '../../../../../orchestration/terminal-authority/release/worker-terminal-release-reconciliation'
import { OrcaRuntimeService } from '../../../../../orca-runtime'
import { isStreamingMethod, eraseRpcMethods, type RpcContext } from '../../../../core'
import { ORCHESTRATION_METHODS } from '../../orchestration'

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
    const method = eraseRpcMethods(ORCHESTRATION_METHODS).find(
      (candidate) => candidate.name === name
    )
    if (!method || isStreamingMethod(method)) {
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

  it('settles a closed terminal after restart when exact process liveness is exited', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    const resource = db.getWorkerTerminalResourceByOwner(dispatchId)
    expect(resource).toBeDefined()

    // Simulate a crash seam after closeTerminal succeeded but before its durable settlement.
    vi.spyOn(db, 'settleWorkerTerminalRelease').mockImplementationOnce(() => {
      throw new Error('SQLite interrupted after terminal close')
    })
    await expect(call('orchestration.workerRelease', { dispatch: dispatchId })).rejects.toThrow(
      'SQLite interrupted after terminal close'
    )
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('releasing')
    expect(runtime.closeTerminal).toHaveBeenCalledTimes(1)

    vi.mocked(runtime.showTerminal).mockRejectedValue(new Error('terminal_handle_stale'))
    vi.mocked(runtime.getOrchestrationDispatchAuthority).mockReturnValue(null)
    vi.mocked(runtime.getTerminalPaneKey).mockReturnValue(null)
    vi.mocked(runtime.getTerminalProcessIncarnation).mockReturnValue(null)
    vi.spyOn(runtime, 'inspectTerminalProcessIncarnationLiveness').mockResolvedValue('exited')

    await expect(reconcileRequestedWorkerTerminalReleases(runtime)).resolves.toMatchObject({
      attempted: 1,
      released: 1,
      pending: 0
    })
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('released')
    expect(runtime.closeTerminal).toHaveBeenCalledTimes(1)
    expect(runtime.inspectTerminalProcessIncarnationLiveness).toHaveBeenCalledWith(
      resource?.process_incarnation,
      resource?.host_scope
    )

    // A replay sees no backlog and cannot issue another close.
    await expect(reconcileRequestedWorkerTerminalReleases(runtime)).resolves.toMatchObject({
      attempted: 0
    })
    expect(runtime.closeTerminal).toHaveBeenCalledTimes(1)
  })

  const currentIncarnation = 'pty-worker:11111111-1111-4111-8111-111111111111'

  /** A current worker whose terminal is gone; the local owner answers with `listing`. */
  function loseWorkerTerminal(
    listing: () => Promise<{ processes: never[]; inProcessOwner: boolean }>
  ): void {
    vi.mocked(runtime.getTerminalProcessIncarnation).mockImplementation((handle) =>
      handle === 'term_worker' ? currentIncarnation : null
    )
    vi.mocked(runtime.getOrchestrationDispatchAuthority).mockImplementation((handle) =>
      handle === 'term_worker'
        ? ({
            terminalHandle: handle,
            paneKey: workerPaneKey,
            processIncarnation: currentIncarnation,
            hostScope: { kind: 'local', hostId: 'local' }
          } as never)
        : null
    )
    runtime.setPtyController({ listLocalProcessesForExitProof: listing } as never)
  }

  function goneAfterSettle(): void {
    vi.mocked(runtime.showTerminal).mockRejectedValue(new Error('terminal_handle_stale'))
    vi.spyOn(runtime, 'resolveTerminalHandleByProcessIncarnation').mockReturnValue(null)
  }

  it('releases a requested worker whose exited terminal is gone, keeping its transcript readable', async () => {
    setup()
    loseWorkerTerminal(async () => ({ processes: [], inProcessOwner: false }))
    const { dispatchId } = await startSettledWorker()
    const resource = db.getWorkerTerminalResourceByOwner(dispatchId)!
    const transcriptPath = path.join(os.tmpdir(), 'claude-session-1.jsonl')
    db.db.prepare('UPDATE worker_terminal_resources SET resume_session = ? WHERE id = ?').run(
      JSON.stringify({
        agent: 'claude',
        providerSession: {
          key: 'session_id',
          id: 'claude-session-1',
          transcriptPath
        },
        connectionId: null
      }),
      resource.id
    )
    goneAfterSettle()

    await expect(
      call('orchestration.workerRelease', { dispatch: dispatchId })
    ).resolves.toMatchObject({
      state: 'released',
      processAction: 'none',
      archive: { source: 'transcript', status: 'captured' }
    })
    expect(JSON.parse(db.getWorkerTerminalArchive(dispatchId)!.content)).toMatchObject({
      agent: 'claude',
      sessionId: 'claude-session-1',
      transcriptPath
    })
    await expect(
      call('orchestration.workerRelease', { dispatch: dispatchId })
    ).resolves.toMatchObject({
      state: 'already_released'
    })
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('lets startup recovery finish a requested release once the owner proves exit', async () => {
    setup()
    loseWorkerTerminal(async () => ({ processes: [], inProcessOwner: false }))
    const { dispatchId } = await startSettledWorker()
    expect(db.requestWorkerTerminalRelease(dispatchId).disposition).toBe('requested')
    goneAfterSettle()

    await expect(reconcileRequestedWorkerTerminalReleases(runtime)).resolves.toMatchObject({
      attempted: 1,
      released: 1,
      pending: 0
    })
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      release_state: 'released',
      archive_source: 'terminal',
      archive_status: 'unavailable'
    })
    await expect(reconcileRequestedWorkerTerminalReleases(runtime)).resolves.toMatchObject({
      attempted: 0
    })
  })

  it('keeps a worker the coordinator kept open while its exit proof was pending', async () => {
    setup()
    const listing = deferred<{ processes: never[]; inProcessOwner: boolean }>()
    loseWorkerTerminal(() => listing.promise)
    const { dispatchId } = await startSettledWorker()
    goneAfterSettle()

    const release = call('orchestration.workerRelease', { dispatch: dispatchId })
    await vi.waitFor(() =>
      expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('requested')
    )
    await call('orchestration.workerRetain', { dispatch: dispatchId })
    listing.resolve({ processes: [], inProcessOwner: false })

    await expect(release).resolves.not.toMatchObject({ state: 'released' })
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      ownership_state: 'owned',
      release_state: 'retained'
    })
    expect(db.getWorkerTerminalArchive(dispatchId)).toBeUndefined()
  })

  it('needs this process to have seen the exit before its own provider proves it', async () => {
    setup()
    loseWorkerTerminal(async () => ({ processes: [], inProcessOwner: true }))
    const { dispatchId } = await startSettledWorker()
    goneAfterSettle()

    // An empty in-process list cannot speak for a worker another owner may still run.
    await expect(
      call('orchestration.workerRelease', { dispatch: dispatchId })
    ).resolves.toMatchObject({
      state: 'release_unknown'
    })
    runtime.recordInProcessPtyExit(currentIncarnation)
    await expect(
      call('orchestration.workerRelease', { dispatch: dispatchId })
    ).resolves.toMatchObject({
      state: 'released',
      processAction: 'none'
    })
  })

  it('records one recovery attempt when reconciliation joins an interactive release', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    const resourceId = db.getWorkerTerminalResourceByOwner(dispatchId)?.id
    expect(resourceId).toBeDefined()
    const pendingClose = deferred<Awaited<ReturnType<OrcaRuntimeService['closeTerminal']>>>()
    vi.mocked(runtime.closeTerminal).mockReturnValue(pendingClose.promise)

    const interactive = call('orchestration.workerRelease', { dispatch: dispatchId })
    await vi.waitFor(() => expect(runtime.closeTerminal).toHaveBeenCalledTimes(1))
    const first = reconcileRequestedWorkerTerminalReleases(runtime)
    const second = reconcileRequestedWorkerTerminalReleases(runtime)
    expect(second).toBe(first)
    pendingClose.resolve({ handle: 'term_worker', tabId: 'tab-worker', ptyKilled: true })

    await expect(interactive).resolves.toMatchObject({ state: 'released' })
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ attempted: 1, released: 1 }),
      expect.objectContaining({ attempted: 1, released: 1 })
    ])
    expect(runtime.closeTerminal).toHaveBeenCalledTimes(1)
    expect(db.getWorkerTerminalResource(resourceId!)).toMatchObject({
      recovery_attempt_count: 1,
      last_recovery_at: expect.any(String)
    })

    await expect(reconcileRequestedWorkerTerminalReleases(runtime)).resolves.toMatchObject({
      attempted: 0
    })
    expect(db.getWorkerTerminalResource(resourceId!)?.recovery_attempt_count).toBe(1)
  })
})
