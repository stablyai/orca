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
import { recordWorkerResumeSession } from '../../../../../orchestration/db/dispatch-context/worker-follow-up-lineage'
import { LocalPtyProvider } from '../../../../../../providers/local-pty/local-pty-provider'
import { exitListeners } from '../../../../../../providers/local-pty/local-pty-provider-state'
import type { IPtyProvider } from '../../../../../../providers/pty/provider-contract'
import type { PtyProcessInfo } from '../../../../../../providers/pty/process-info'
import { listLocalProcessesForExitProofFromRuntimeController } from '../../../../../../ipc/pty/runtime/inventory-operations'
import { observeInProcessWorkerExits } from '../../../../../../ipc/pty/runtime/in-process-exit-observer'
import { PTY_CONTROLLER_LIST_TIMEOUT_MS } from '../../../../../terminal/lifecycle/pty-controller-inventory-budget'

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
  const workerIncarnation = 'pty-worker:11111111-1111-4111-8111-111111111111'

  function setup(): void {
    db = new OrchestrationDb(':memory:')
    dbOpen = true
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord' ? coordinatorPaneKey : handle === 'term_worker' ? workerPaneKey : null
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
      handle === 'term_worker' ? workerIncarnation : null
    )
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) =>
      handle === 'term_worker'
        ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub supplies only the authority fields worker start reads.
          ({
            terminalHandle: handle,
            paneKey: workerPaneKey,
            processIncarnation: workerIncarnation,
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
    observeInProcessWorkerExits(undefined)
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

  /** A current worker whose terminal is gone; the local owner answers with `listing`. */
  function loseWorkerTerminal(
    listing: () => Promise<{ processes: PtyProcessInfo[]; inProcessOwner: boolean }>
  ): void {
    runtime.setPtyController({
      write: () => false,
      kill: () => false,
      getForegroundProcess: async () => null,
      listLocalProcessesForExitProof: listing
    })
  }

  function goneAfterSettle(): void {
    vi.mocked(runtime.showTerminal).mockRejectedValue(new Error('terminal_handle_stale'))
    vi.spyOn(runtime, 'resolveTerminalHandleByProcessIncarnation').mockReturnValue(null)
  }

  function saveSession(resourceId: string, sessionId: string): string {
    const transcriptPath = path.join(os.tmpdir(), `${sessionId}.jsonl`)
    recordWorkerResumeSession(db, resourceId, {
      paneKey: workerPaneKey,
      processIncarnation: workerIncarnation,
      connectionId: null,
      agent: 'claude',
      providerSession: { key: 'session_id', id: sessionId, transcriptPath },
      observedAt: 0
    })
    return transcriptPath
  }

  it('releases a requested worker whose exited terminal is gone, keeping its newest saved transcript', async () => {
    setup()
    const listing = deferred<{ processes: never[]; inProcessOwner: boolean }>()
    loseWorkerTerminal(() => listing.promise)
    const { dispatchId } = await startSettledWorker()
    const resourceId = db.getWorkerTerminalResourceByOwner(dispatchId)!.id
    saveSession(resourceId, 'claude-session-a')
    goneAfterSettle()

    const release = call('orchestration.workerRelease', { dispatch: dispatchId })
    await vi.waitFor(() =>
      expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('requested')
    )
    // A /clear lands while the exit proof is pending; the archive must name the newer conversation.
    const transcriptPath = saveSession(resourceId, 'claude-session-b')
    listing.resolve({ processes: [], inProcessOwner: false })

    await expect(release).resolves.toMatchObject({
      state: 'released',
      processAction: 'none',
      archive: { source: 'transcript', status: 'captured' }
    })
    expect(JSON.parse(db.getWorkerTerminalArchive(dispatchId)!.content)).toMatchObject({
      agent: 'claude',
      sessionId: 'claude-session-b',
      transcriptPath
    })
    await expect(
      call('orchestration.workerRelease', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'already_released' })
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

  it('lets this process vouch only for worker exits its own terminals reported', async () => {
    setup()
    const inProcess = new LocalPtyProvider()
    loseWorkerTerminal(() =>
      listLocalProcessesForExitProofFromRuntimeController(
        { getLocalPtyProviderStartupPromise: () => undefined },
        () => inProcess
      )
    )
    observeInProcessWorkerExits(runtime)
    const { dispatchId } = await startSettledWorker()
    goneAfterSettle()
    const reportExit = (incarnationId: string) => {
      for (const listener of exitListeners) {
        listener({ id: 'pty-worker', code: 0, incarnationId })
      }
    }

    // A reused PTY id that exited under another incarnation says nothing about this worker.
    reportExit('33333333-3333-4333-8333-333333333333')
    await expect(
      call('orchestration.workerRelease', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'release_unknown' })

    reportExit('11111111-1111-4111-8111-111111111111')
    await expect(
      call('orchestration.workerRelease', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'released', processAction: 'none' })
  })

  it('cannot prove a recorded worker exited until local terminals finish starting', async () => {
    setup()
    let finishStartup!: () => void
    const startup = new Promise<void>((resolve) => (finishStartup = resolve))
    let serving: Pick<IPtyProvider, 'listProcesses'> = new LocalPtyProvider()
    loseWorkerTerminal(() =>
      listLocalProcessesForExitProofFromRuntimeController(
        { getLocalPtyProviderStartupPromise: () => startup },
        () => serving
      )
    )
    const scope = JSON.stringify({ kind: 'local', hostId: 'local' })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const pending = runtime.inspectTerminalProcessIncarnationLiveness(workerIncarnation, scope)
      await vi.advanceTimersByTimeAsync(PTY_CONTROLLER_LIST_TIMEOUT_MS)
      await expect(pending).resolves.toBe('unverifiable')
    } finally {
      vi.useRealTimers()
    }

    serving = {
      listProcesses: async () => [
        {
          id: 'pty-worker',
          incarnationId: '11111111-1111-4111-8111-111111111111',
          cwd: '',
          title: ''
        }
      ]
    }
    finishStartup()
    await expect(
      runtime.inspectTerminalProcessIncarnationLiveness(workerIncarnation, scope)
    ).resolves.toBe('live')
    serving = { listProcesses: async () => [] }
    await expect(
      runtime.inspectTerminalProcessIncarnationLiveness(workerIncarnation, scope)
    ).resolves.toBe('exited')
  })

  it('does not let an in-process fallback speak for a worker it never ran', async () => {
    setup()
    // Daemon startup failed open and left this process's own provider serving, with nothing listed.
    const fallback = new LocalPtyProvider()
    loseWorkerTerminal(() =>
      listLocalProcessesForExitProofFromRuntimeController(
        { getLocalPtyProviderStartupPromise: () => Promise.resolve() },
        () => fallback
      )
    )
    await expect(
      runtime.inspectTerminalProcessIncarnationLiveness(
        workerIncarnation,
        JSON.stringify({ kind: 'local', hostId: 'local' })
      )
    ).resolves.toBe('unverifiable')
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
