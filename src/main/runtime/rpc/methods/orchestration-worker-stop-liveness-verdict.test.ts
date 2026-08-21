import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { ORCHESTRATION_METHODS } from './orchestration'

// The aggregate terminal inventory only iterates registered providers, so a
// dropped relay clears `connected` for every remote PTY at once. That is lost
// contact, not a death certificate.
describe('worker-stop against a terminal we lost contact with', () => {
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
      connected: false,
      status: 'exited'
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

  function createWorker() {
    const run = db.createRun({
      objective: 'Verdict',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    const task = db.createTask({ spec: 'stop worker', runId: run.id })
    const started = db.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: {},
      runtimeEpoch: runtime.getRuntimeId()
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
    db.markWorkerDispatchReady(started.dispatch.id)
    return started.dispatch
  }

  it('reports the process as unverifiable, not exited, when the link dropped', async () => {
    vi.spyOn(runtime, 'getTerminalLivenessVerdict').mockReturnValue({
      status: 'unverifiable',
      reason: 'its SSH provider is no longer registered'
    })
    const closeTerminal = vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({
      handle: 'term_worker',
      tabId: 'tab_worker',
      ptyKilled: false,
      ptyStopVerdict: 'unverifiable',
      ptyStopReason: 'its SSH provider is no longer registered'
    })
    const dispatch = createWorker()

    await expect(
      call('orchestration.workerShow', { dispatch: dispatch.id })
    ).resolves.toMatchObject({
      observation: {
        status: 'unverifiable',
        exactWorker: true,
        reason: 'its SSH provider is no longer registered'
      }
    })

    const stopped = (await call('orchestration.workerStop', { dispatch: dispatch.id })) as {
      state: string
      processAction: string
      lastError: string
    }
    // Losing contact is a reason to report honestly, never to stop trying.
    expect(closeTerminal).toHaveBeenCalledWith('term_worker')
    expect(stopped.processAction).toBe('closed_agent_terminal')
    expect(stopped.state).toBe('stop_unknown')
    expect(stopped.lastError).toContain('could not be confirmed stopped')
    expect(stopped.lastError).not.toContain('exited')
  })

  it('does not settle a bare false close as stopped', async () => {
    vi.spyOn(runtime, 'showTerminal').mockResolvedValue({
      handle: 'term_worker',
      worktreeId: 'repo::worktree',
      connected: true,
      status: 'running'
    } as never)
    vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({
      handle: 'term_worker',
      tabId: 'tab_worker',
      ptyKilled: false
    })
    const dispatch = createWorker()

    const stopped = (await call('orchestration.workerStop', { dispatch: dispatch.id })) as {
      state: string
      lastError: string
    }

    expect(stopped.state).toBe('stop_unknown')
    expect(stopped.lastError).toContain('could not be confirmed stopped')
  })

  it('uses the canonical live verdict for an observed process', async () => {
    vi.spyOn(runtime, 'showTerminal').mockResolvedValue({
      handle: 'term_worker',
      worktreeId: 'repo::worktree',
      connected: true,
      status: 'running'
    } as never)
    vi.spyOn(runtime, 'getTerminalLivenessVerdict').mockReturnValue({
      status: 'live',
      ptyIds: ['runtime:pty:1']
    })
    const dispatch = createWorker()

    await expect(
      call('orchestration.workerShow', { dispatch: dispatch.id })
    ).resolves.toMatchObject({
      observation: { status: 'live', exactWorker: true }
    })
  })

  it('does not close a pane after user input transfers ownership', async () => {
    vi.spyOn(runtime, 'showTerminal').mockResolvedValue({
      handle: 'term_worker',
      worktreeId: 'repo::worktree',
      connected: true,
      status: 'running'
    } as never)
    vi.spyOn(runtime, 'getTerminalLivenessVerdict').mockReturnValue({
      status: 'live',
      ptyIds: ['runtime:pty:1']
    })
    const closeTerminal = vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({
      handle: 'term_worker',
      tabId: 'tab_worker',
      ptyKilled: true
    })
    const dispatch = createWorker()

    await expect(
      call('orchestration.workerTerminalUserInput', {
        paneKey: 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      })
    ).resolves.toMatchObject({ changed: 1 })

    await expect(
      call('orchestration.workerStop', { dispatch: dispatch.id })
    ).resolves.toMatchObject({
      state: 'stop_unknown',
      processAction: 'none',
      lastError: 'The worker terminal is user_owned; no terminal was closed.'
    })
    expect(closeTerminal).not.toHaveBeenCalled()
  })

  it('does not close a legacy worker terminal without an ownership record', async () => {
    vi.spyOn(runtime, 'showTerminal').mockResolvedValue({
      handle: 'term_worker',
      worktreeId: 'repo::worktree',
      connected: true,
      status: 'running'
    } as never)
    vi.spyOn(runtime, 'getTerminalLivenessVerdict').mockReturnValue({
      status: 'live',
      ptyIds: ['runtime:pty:1']
    })
    const closeTerminal = vi.spyOn(runtime, 'closeTerminal')
    const dispatch = createWorker()
    const resource = db.getWorkerTerminalResourceByOwner(dispatch.id)
    if (!resource) {
      throw new Error('Expected worker terminal resource')
    }
    ;(db as unknown as { db: { prepare: (sql: string) => { run: (id: string) => void } } }).db
      .prepare('DELETE FROM worker_terminal_resources WHERE id = ?')
      .run(resource.id)

    await expect(
      call('orchestration.workerStop', { dispatch: dispatch.id })
    ).resolves.toMatchObject({
      state: 'stop_unknown',
      processAction: 'none',
      lastError: 'The worker terminal is unproven; no terminal was closed.'
    })
    expect(closeTerminal).not.toHaveBeenCalled()
  })

  it('linearizes stop before a concurrent user takeover', () => {
    const dispatch = createWorker()
    expect(db.beginWorkerStop(dispatch.id, runtime.getRuntimeId()).disposition).toBe('stopping')

    expect(db.markWorkerTerminalUserOwned('tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')).toBe(
      0
    )
    expect(db.getWorkerTerminalResourceByOwner(dispatch.id)).toMatchObject({
      ownership_state: 'owned',
      release_state: 'not_requested'
    })
  })

  it('does not let abandon overwrite a stop in progress', () => {
    const dispatch = createWorker()
    expect(db.beginWorkerStop(dispatch.id, runtime.getRuntimeId()).disposition).toBe('stopping')

    expect(() => db.abandonWorkerDispatch(dispatch.id)).toThrow(
      'is stopping; wait for worker-stop to settle before abandoning'
    )
    expect(db.getWorkerDispatch(dispatch.id)?.state).toBe('stopping')
  })

  it('still reports a locally observed exit as exited', async () => {
    const dispatch = createWorker()

    await expect(
      call('orchestration.workerShow', { dispatch: dispatch.id })
    ).resolves.toMatchObject({
      observation: { status: 'exited', exactWorker: true }
    })

    const stopped = (await call('orchestration.workerStop', { dispatch: dispatch.id })) as {
      lastError: string
    }
    expect(stopped.lastError).toBe('The recorded worker process is exited; no terminal was closed.')
  })
})
