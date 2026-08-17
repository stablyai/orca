import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { ORCHESTRATION_METHODS } from './orchestration'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

describe('orchestration worker recovery', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(
      'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue('runtime:pty:1')
    vi.spyOn(runtime, 'showTerminal').mockResolvedValue({
      handle: 'term_worker',
      worktreeId: 'repo::worktree',
      connected: true,
      status: 'running'
    } as never)
    vi.spyOn(runtime, 'readTerminal').mockResolvedValue({
      handle: 'term_worker',
      status: 'running',
      tail: ['working'],
      truncated: false,
      nextCursor: null
    })
    vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({
      handle: 'term_worker',
      tabId: 'tab-worker',
      ptyKilled: true
    } as never)
  })

  afterEach(() => db.close())

  async function call(name: string, params: Record<string, unknown>) {
    const method = ORCHESTRATION_METHODS.find((candidate) => candidate.name === name)
    if (!method) {
      throw new Error(`Method not found: ${name}`)
    }
    return method.handler(method.params!.parse(params), { runtime })
  }

  function createWorker(runtimeEpoch = runtime.getRuntimeId(), ready = true) {
    const run = db.createRun({
      objective: 'Recovery',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    const task = db.createTask({ spec: 'recover worker', runId: run.id })
    const started = db.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: {},
      runtimeEpoch
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_worker',
      paneKey: 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      processIncarnation: 'runtime:pty:1',
      worktreeId: 'repo::worktree',
      setupState: 'not_applicable',
      effects: [{ kind: 'terminal', action: 'created', id: 'term_worker' }],
      terminalOwnership: 'created'
    })
    if (ready) {
      db.markWorkerDispatchReady(started.dispatch.id)
    } else {
      db.markWorkerStartUnknown(started.dispatch.id, 'dispatch_input', 'connection lost')
    }
    return { run, task, dispatch: started.dispatch }
  }

  it('shows and reads only the exact attached worker process', async () => {
    const { dispatch } = createWorker()

    await expect(
      call('orchestration.workerShow', { dispatch: dispatch.id })
    ).resolves.toMatchObject({
      worker: { state: 'ready' },
      observation: { status: 'live', exactWorker: true },
      terminal: { handle: 'term_worker' }
    })
    await expect(
      call('orchestration.workerRead', { dispatch: dispatch.id })
    ).resolves.toMatchObject({
      dispatchId: dispatch.id,
      terminal: { tail: ['working'] }
    })
  })

  it('stops an exact worker whose start receipt is unknown', async () => {
    const { task, dispatch } = createWorker(runtime.getRuntimeId(), false)

    await expect(
      call('orchestration.workerStop', { dispatch: dispatch.id })
    ).resolves.toMatchObject({
      state: 'stopped',
      processAction: 'closed_agent_terminal'
    })
    expect(runtime.closeTerminal).toHaveBeenCalledWith('term_worker')
    expect(db.getTask(task.id)?.status).toBe('blocked')
  })

  it('keeps an in-flight stop fenced during runtime-epoch reconciliation', async () => {
    const { dispatch } = createWorker('previous_runtime')
    const pendingObservation = deferred<Awaited<ReturnType<OrcaRuntimeService['showTerminal']>>>()
    vi.mocked(runtime.showTerminal)
      .mockReturnValueOnce(pendingObservation.promise)
      .mockResolvedValue({
        handle: 'term_worker',
        worktreeId: 'repo::worktree',
        connected: true,
        status: 'running'
      } as never)

    const stop = call('orchestration.workerStop', { dispatch: dispatch.id })
    await vi.waitFor(() => expect(runtime.showTerminal).toHaveBeenCalledTimes(1))
    await expect(
      call('orchestration.workerShow', { dispatch: dispatch.id })
    ).resolves.toMatchObject({ worker: { state: 'stopping' } })
    await expect(call('orchestration.workerAbandon', { dispatch: dispatch.id })).rejects.toThrow(
      'is stopping; wait for worker-stop to settle before abandoning'
    )

    pendingObservation.resolve({
      handle: 'term_worker',
      worktreeId: 'repo::worktree',
      connected: true,
      status: 'running'
    } as never)
    await expect(stop).resolves.toMatchObject({
      state: 'stopped',
      processAction: 'closed_agent_terminal'
    })
  })

  it('does not adopt or stop a same-looking pane with a new process incarnation', async () => {
    const { task, dispatch } = createWorker()
    vi.mocked(runtime.getTerminalProcessIncarnation).mockReturnValue('runtime:pty:2')

    await expect(
      call('orchestration.workerShow', { dispatch: dispatch.id })
    ).resolves.toMatchObject({
      worker: { state: 'ready' },
      observation: { status: 'identity_changed', exactWorker: false },
      terminal: null
    })
    await expect(call('orchestration.workerRead', { dispatch: dispatch.id })).rejects.toMatchObject(
      {
        code: 'worker_identity_changed'
      }
    )
    await expect(
      call('orchestration.workerStop', { dispatch: dispatch.id })
    ).resolves.toMatchObject({
      state: 'stop_unknown',
      processAction: 'none'
    })
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
    expect(db.getTask(task.id)?.status).toBe('blocked')
  })

  it('labels an exact but disconnected worker as exited and does not close it again', async () => {
    const { task, dispatch } = createWorker()
    vi.mocked(runtime.showTerminal).mockResolvedValue({
      handle: 'term_worker',
      worktreeId: 'repo::worktree',
      connected: false,
      writable: false
    } as never)

    await expect(
      call('orchestration.workerShow', { dispatch: dispatch.id })
    ).resolves.toMatchObject({
      observation: { status: 'exited', exactWorker: true },
      terminal: { handle: 'term_worker', connected: false }
    })
    await expect(
      call('orchestration.workerStop', { dispatch: dispatch.id })
    ).resolves.toMatchObject({
      state: 'stop_unknown',
      processAction: 'none'
    })
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
    expect(db.getTask(task.id)?.status).toBe('blocked')
  })

  it('turns an interrupted start into inspectable unknown after runtime restart', async () => {
    const run = db.createRun({
      objective: 'Interrupted start',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    const task = db.createTask({ spec: 'interrupted', runId: run.id })
    const started = db.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: {},
      runtimeEpoch: 'previous_runtime'
    })
    db.recordWorkerStage({
      dispatchId: started.dispatch.id,
      stage: 'worktree_creating'
    })

    await expect(
      call('orchestration.workerShow', { dispatch: started.dispatch.id })
    ).resolves.toMatchObject({
      worker: { state: 'start_unknown', stage: 'worktree_creating' },
      observation: { status: 'unattached', exactWorker: false }
    })
    expect(db.getTask(task.id)?.status).toBe('blocked')
  })

  it('turns an interrupted stop into unknown after runtime restart', async () => {
    const { task, dispatch } = createWorker('previous_runtime')
    db.beginWorkerStop(dispatch.id, 'previous_runtime')

    await expect(
      call('orchestration.workerShow', { dispatch: dispatch.id })
    ).resolves.toMatchObject({
      worker: { state: 'stop_unknown' }
    })
    expect(db.getTask(task.id)?.status).toBe('blocked')
  })

  it('reconciles a stop_unknown Dispatch from an authoritative remote stopped receipt', async () => {
    const run = db.createRun({
      objective: 'Lost remote stop response',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    const task = db.createTask({ spec: 'stop remote worker', runId: run.id })
    const started = db.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: {},
      runtimeEpoch: runtime.getRuntimeId(),
      federation: {
        environmentId: 'environment_windows',
        environmentName: 'windows',
        peerFingerprint: 'windows_peer',
        protocolVersion: 1
      }
    })
    db.markWorkerStartUnknown(started.dispatch.id, 'remote_attach', 'response lost')
    db.beginWorkerStop(started.dispatch.id, runtime.getRuntimeId())
    db.markWorkerStopUnknown(started.dispatch.id, 'stop response lost')
    vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockReturnValue({
      environmentId: 'environment_windows',
      name: 'windows',
      peerFingerprint: 'windows_peer'
    })
    vi.spyOn(runtime, 'callOrchestrationWorkerServer').mockResolvedValue({
      runtimeEpoch: 'windows_epoch',
      attachment: {
        state: 'stopped',
        stage: 'process_stopped',
        last_error: null,
        worktree_id: 'repo::windows-worktree',
        terminal_handle: 'term_windows_worker',
        setup_state: 'running',
        effects: [],
        residualResources: []
      },
      terminal: { handle: 'term_windows_worker', connected: false },
      observation: { status: 'exited', exactWorker: true }
    })

    await expect(
      call('orchestration.workerShow', { dispatch: started.dispatch.id })
    ).resolves.toMatchObject({
      worker: { state: 'stopped', stage: 'process_stopped', last_error: null },
      observation: { status: 'exited', exactWorker: true }
    })
    expect(db.getTask(task.id)?.status).toBe('blocked')
  })
})
