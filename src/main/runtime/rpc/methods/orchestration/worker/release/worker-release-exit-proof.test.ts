import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const newerDaemonHold = vi.hoisted(() => ({ held: false }))
vi.mock(
  '../../../../../../daemon/providers/routing/daemon-newer-protocol-hold',
  async (original) => ({
    ...(await original<Record<string, unknown>>()),
    isHoldingForNewerProtocolDaemon: () => newerDaemonHold.held
  })
)
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
import { DaemonSessionOwnerResolver } from '../../../../../../daemon/providers/routing/daemon-session-owner-resolution'
import { sweepStoppedWorkerTerminals } from '../../../../../orchestration/terminal-authority/release/stopped-worker-terminal-release'

function isStartReceipt(value: unknown): value is { dispatchId: string; state: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'dispatchId' in value &&
    typeof value.dispatchId === 'string' &&
    'state' in value &&
    typeof value.state === 'string'
  )
}

const workerGeneration = '11111111-1111-4111-8111-111111111111'
const otherGeneration = '33333333-3333-4333-8333-333333333333'

/**
 * Two daemon generations behind the real routing resolver, each listing `pty-worker` under its own
 * incarnation, with the route on the first. The routed view lists only the first.
 */
function twoGenerationDaemon(
  routedIncarnation: string,
  unroutedIncarnation: string
): Pick<IPtyProvider, 'listProcesses'> {
  const generation = (incarnationId: string) => ({
    listProcesses: async () => [{ id: 'pty-worker', incarnationId, cwd: '', title: '' }]
  })
  const routedGeneration = generation(routedIncarnation)
  const generations = [routedGeneration, generation(unroutedIncarnation)]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: inventory listing reads only listProcesses from each generation.
  const providers = generations as unknown as IPtyProvider[]
  const resolver = new DaemonSessionOwnerResolver(providers, new Map())
  resolver.recordRoute('pty-worker', providers[0]!, routedIncarnation)
  return { listProcesses: (opts) => resolver.listProcesses(opts) }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

describe('worker release once the exact process is proven exited', () => {
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
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: release reads only the handle, worktree and status of a shown terminal.
      async (handle) => ({ handle, worktreeId: 'repo::worktree', status: 'running' }) as never
    )
    vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: worker start reads only the workspace id.
      { id: 'repo::worktree' } as never
    )
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
    newerDaemonHold.held = false
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
    const result: unknown = await call('orchestration.workerStart', {
      task: task.id,
      from: 'term_coord',
      agent: 'codex'
    })
    if (!isStartReceipt(result)) {
      throw new Error('worker start returned no receipt')
    }
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

    await expect(release).resolves.toMatchObject({ state: 'retained', processAction: 'none' })
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

  it('pays one bounded startup wait per hung startup, not one per backlog row', async () => {
    setup()
    const startup = new Promise<void>(() => {})
    loseWorkerTerminal(() =>
      listLocalProcessesForExitProofFromRuntimeController(
        { getLocalPtyProviderStartupPromise: () => startup },
        () => ({ listProcesses: async () => [] })
      )
    )
    const { dispatchId } = await startSettledWorker()
    expect(db.requestWorkerTerminalRelease(dispatchId).disposition).toBe('requested')
    goneAfterSettle()
    const resource = db.getWorkerTerminalResourceByOwner(dispatchId)!
    const backlogRows = 20
    vi.spyOn(db, 'listWorkerTerminalReleaseBacklog').mockReturnValue(
      Array.from({ length: backlogRows }, () => resource)
    )
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      let settled = false
      const pass = reconcileRequestedWorkerTerminalReleases(runtime).finally(() => {
        settled = true
      })
      let waitedMs = 0
      while (!settled && waitedMs <= backlogRows * PTY_CONTROLLER_LIST_TIMEOUT_MS) {
        await vi.advanceTimersByTimeAsync(100)
        waitedMs += 100
      }
      await expect(pass).resolves.toMatchObject({ attempted: backlogRows, pending: backlogRows })
      expect(waitedMs).toBeLessThanOrEqual(PTY_CONTROLLER_LIST_TIMEOUT_MS + 100)
    } finally {
      vi.useRealTimers()
    }
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('requested')
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

  it("reports the keep-open that landed while a stopped worker's exit proof was pending", async () => {
    setup()
    const listing = deferred<{ processes: never[]; inProcessOwner: boolean }>()
    const proving = vi.fn(() => listing.promise)
    loseWorkerTerminal(proving)
    const { dispatchId } = await startSettledWorker()
    // A stopped worker is retained as identity_unproven before its exit proof starts.
    db.db
      .prepare("UPDATE worker_dispatches SET state = 'stopped' WHERE dispatch_id = ?")
      .run(dispatchId)
    goneAfterSettle()

    const release = call('orchestration.workerRelease', { dispatch: dispatchId })
    await vi.waitFor(() => expect(proving).toHaveBeenCalled())
    await call('orchestration.workerKeepOpen', { paneKey: workerPaneKey, keep: true })
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      release_state: 'retained',
      retained_reason: 'user_kept'
    })
    listing.resolve({ processes: [], inProcessOwner: false })

    await expect(release).resolves.toMatchObject({
      state: 'retained',
      reason: 'user_kept',
      processAction: 'none'
    })
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      ownership_state: 'owned',
      release_state: 'retained',
      retained_reason: 'user_kept'
    })
  })

  it("reports a transfer that landed while a stopped worker's exit proof was pending", async () => {
    setup()
    const listing = deferred<{ processes: never[]; inProcessOwner: boolean }>()
    const proving = vi.fn(() => listing.promise)
    loseWorkerTerminal(proving)
    const { dispatchId } = await startSettledWorker()
    db.db
      .prepare("UPDATE worker_dispatches SET state = 'stopped' WHERE dispatch_id = ?")
      .run(dispatchId)
    goneAfterSettle()
    const resourceId = db.getWorkerTerminalResourceByOwner(dispatchId)!.id

    const release = call('orchestration.workerRelease', { dispatch: dispatchId })
    await vi.waitFor(() => expect(proving).toHaveBeenCalled())
    // A follow-up worker takes the terminal over while the proof is pending.
    const { dispatch: successor } = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: db.createTask({ spec: 'follow-up worker', runId: activeRunId }).id,
      startOptions: {}
    })
    db.db
      .prepare(
        `UPDATE worker_terminal_resources
         SET owner_dispatch_id = ?, prior_owner_dispatch_ids = json_array(?) WHERE id = ?`
      )
      .run(successor.id, dispatchId, resourceId)
    listing.resolve({ processes: [], inProcessOwner: false })

    await expect(release).resolves.toMatchObject({
      state: 'retained',
      reason: 'ownership_transferred',
      processAction: 'none'
    })
    expect(db.getWorkerTerminalResource(resourceId)).toMatchObject({
      owner_dispatch_id: successor.id,
      ownership_state: 'owned'
    })
    expect(db.getWorkerTerminalResource(resourceId)?.release_state).not.toBe('released')
  })

  describe("when daemon generations share the worker's PTY id", () => {
    function serveLocalDaemon(daemon: Pick<IPtyProvider, 'listProcesses'>): void {
      loseWorkerTerminal(() =>
        listLocalProcessesForExitProofFromRuntimeController(
          { getLocalPtyProviderStartupPromise: () => undefined },
          () => daemon
        )
      )
    }

    async function stoppedWorkerFromBeforeTheSweep(): Promise<string> {
      const { dispatchId } = await startSettledWorker()
      db.db
        .prepare("UPDATE worker_dispatches SET state = 'stopped' WHERE dispatch_id = ?")
        .run(dispatchId)
      // The sweep judges only rows written before its own (whole-second) start.
      db.db
        .prepare(
          "UPDATE worker_terminal_resources SET updated_at = datetime('now', '-1 minute') WHERE owner_dispatch_id = ?"
        )
        .run(dispatchId)
      goneAfterSettle()
      return dispatchId
    }

    it('lists the unrouted generation too, which the routed view leaves out', async () => {
      const daemon = twoGenerationDaemon(otherGeneration, workerGeneration)
      await expect(daemon.listProcesses()).resolves.toEqual([
        expect.objectContaining({ incarnationId: otherGeneration })
      ])
      await expect(
        listLocalProcessesForExitProofFromRuntimeController(
          { getLocalPtyProviderStartupPromise: () => undefined },
          () => daemon
        )
      ).resolves.toMatchObject({
        processes: [
          expect.objectContaining({ incarnationId: otherGeneration }),
          expect.objectContaining({ incarnationId: workerGeneration })
        ],
        inProcessOwner: false
      })
    })

    it('keeps a release pending while the worker lives on in an unrouted generation', async () => {
      setup()
      serveLocalDaemon(twoGenerationDaemon(otherGeneration, workerGeneration))
      const { dispatchId } = await startSettledWorker()
      goneAfterSettle()

      await expect(
        call('orchestration.workerRelease', { dispatch: dispatchId })
      ).resolves.toMatchObject({ state: 'release_unknown', processAction: 'none' })
      expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).not.toBe('released')
      expect(db.getWorkerTerminalArchive(dispatchId)).toBeUndefined()
    })

    it('releases once neither generation lists the worker', async () => {
      setup()
      serveLocalDaemon(twoGenerationDaemon(otherGeneration, '44444444-4444-4444-8444-444444444444'))
      const { dispatchId } = await startSettledWorker()
      goneAfterSettle()

      await expect(
        call('orchestration.workerRelease', { dispatch: dispatchId })
      ).resolves.toMatchObject({ state: 'released', processAction: 'none' })
    })

    it('leaves a stopped worker owned in the sweep while an unrouted generation runs it', async () => {
      setup()
      serveLocalDaemon(twoGenerationDaemon(otherGeneration, workerGeneration))
      const dispatchId = await stoppedWorkerFromBeforeTheSweep()

      await sweepStoppedWorkerTerminals(runtime, () => false)

      expect(db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
        ownership_state: 'owned',
        release_state: 'not_requested'
      })
    })

    it('sweeps a stopped worker neither generation lists', async () => {
      setup()
      serveLocalDaemon(twoGenerationDaemon(otherGeneration, '44444444-4444-4444-8444-444444444444'))
      const dispatchId = await stoppedWorkerFromBeforeTheSweep()

      await sweepStoppedWorkerTerminals(runtime, () => false)

      expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('released')
    })

    it('refuses when the daemon inventory is incomplete', async () => {
      setup()
      const resolver = new DaemonSessionOwnerResolver(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: inventory listing reads only listProcesses.
        [
          {
            listProcesses: async () => {
              throw new Error('generation unreachable')
            }
          }
        ] as unknown as IPtyProvider[],
        new Map()
      )
      serveLocalDaemon({ listProcesses: (opts) => resolver.listProcesses(opts) })
      await expect(
        runtime.inspectTerminalProcessIncarnationLiveness(
          workerIncarnation,
          JSON.stringify({ kind: 'local', hostId: 'local' })
        )
      ).resolves.toBe('unverifiable')
    })

    it('keeps a release pending while a held newer daemon may still run the worker', async () => {
      setup()
      newerDaemonHold.held = true
      serveLocalDaemon(twoGenerationDaemon(otherGeneration, '44444444-4444-4444-8444-444444444444'))
      const { dispatchId } = await startSettledWorker()
      goneAfterSettle()

      await expect(
        call('orchestration.workerRelease', { dispatch: dispatchId })
      ).resolves.toMatchObject({ state: 'release_unknown', processAction: 'none' })
      expect(db.getWorkerTerminalArchive(dispatchId)).toBeUndefined()
    })

    it('leaves a stopped worker owned in the sweep while a held newer daemon may run it', async () => {
      setup()
      newerDaemonHold.held = true
      serveLocalDaemon(twoGenerationDaemon(otherGeneration, '44444444-4444-4444-8444-444444444444'))
      const dispatchId = await stoppedWorkerFromBeforeTheSweep()

      await sweepStoppedWorkerTerminals(runtime, () => false)

      expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('not_requested')
    })
  })

  it('lets one of two racing releases of a stopped worker settle it; the other reports already released', async () => {
    setup()
    const listing = deferred<{ processes: never[]; inProcessOwner: boolean }>()
    const proving = vi.fn(() => listing.promise)
    loseWorkerTerminal(proving)
    const { dispatchId } = await startSettledWorker()
    db.db
      .prepare("UPDATE worker_dispatches SET state = 'stopped' WHERE dispatch_id = ?")
      .run(dispatchId)
    goneAfterSettle()

    const first = call('orchestration.workerRelease', { dispatch: dispatchId })
    const second = call('orchestration.workerRelease', { dispatch: dispatchId })
    await vi.waitFor(() => expect(proving).toHaveBeenCalledTimes(2))
    listing.resolve({ processes: [], inProcessOwner: false })

    const states = (await Promise.all([first, second])).map((receipt) =>
      typeof receipt === 'object' && receipt !== null && 'state' in receipt ? receipt.state : null
    )
    expect(states.toSorted()).toEqual(['already_released', 'released'])
    // The winner alone announces the transition.
    expect(
      vi
        .mocked(runtime.notifyMessageArrived)
        .mock.calls.filter(
          ([target, kind]) => target === `dispatch:${dispatchId}` && kind === 'status'
        )
    ).toHaveLength(1)
  })
})
