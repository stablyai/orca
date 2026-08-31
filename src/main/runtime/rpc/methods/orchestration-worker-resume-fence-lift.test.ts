import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { ORCHESTRATION_METHODS } from './orchestration'

const WORKER_PANE_KEY = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const WORKTREE_ID = 'repo::worktree'
const LOCAL_HOST_SCOPE = { kind: 'local', hostId: 'local' } as const

// Why (STA-4577): `startFreshSpawn` refuses a fenced pane. Release, retain and user takeover each
// drop the worker's row from the recovery plan, so each has to lift the fence in the same call —
// otherwise it outlives its dispatch and the pane cannot spawn again until the next app start.
// This runtime has no workspace-session store, so the fence here is renderer-only: proving the
// lift still fires is what covers a fence whose persisted record never existed.
describe('settled worker resume fence lift', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let resolveLegacyWorkerTerminalRecovery: ReturnType<typeof vi.fn>

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    resolveLegacyWorkerTerminalRecovery = vi.fn()
    runtime.setNotifier({ resolveLegacyWorkerTerminalRecovery } as never)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(WORKER_PANE_KEY)
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue('runtime:pty:1')
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockReturnValue({
      terminalHandle: 'term_worker',
      paneKey: WORKER_PANE_KEY,
      processIncarnation: 'runtime:pty:1',
      hostScope: LOCAL_HOST_SCOPE
    } as never)
    vi.spyOn(runtime, 'getExactWorkerProviderSession').mockReturnValue(null)
    vi.spyOn(runtime, 'showTerminal').mockResolvedValue({
      handle: 'term_worker',
      worktreeId: WORKTREE_ID,
      connected: true,
      status: 'running'
    } as never)
    vi.spyOn(runtime, 'readTerminal').mockResolvedValue({
      handle: 'term_worker',
      status: 'running',
      tail: ['worker output'],
      truncated: false,
      nextCursor: '1'
    })
    vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({
      handle: 'term_worker',
      tabId: 'tab_worker',
      ptyKilled: true
    } as never)
    vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
    ;(
      runtime as unknown as {
        inspectTerminalProcessIncarnationLiveness: () => Promise<string>
      }
    ).inspectTerminalProcessIncarnationLiveness = vi.fn().mockResolvedValue('live')
  })

  afterEach(() => {
    db.close()
    vi.restoreAllMocks()
  })

  async function call(name: string, params: Record<string, unknown>): Promise<unknown> {
    const method = ORCHESTRATION_METHODS.find((candidate) => candidate.name === name)
    if (!method) {
      throw new Error(`Method not found: ${name}`)
    }
    return method.handler(method.params!.parse(params), { runtime } as never)
  }

  /** A settled worker whose terminal resource is still owned — the exact state the fence covers. */
  function fenceSettledWorker(): string {
    const run = db.createRun({
      objective: 'Fence lift',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    const task = db.createTask({ spec: 'settle then retire', runId: run.id })
    const started = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {},
      runtimeEpoch: runtime.getRuntimeId()
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_worker',
      paneKey: WORKER_PANE_KEY,
      processIncarnation: 'runtime:pty:1',
      worktreeId: WORKTREE_ID,
      setupState: 'not_applicable',
      effects: [{ kind: 'terminal', action: 'created', id: 'term_worker' }],
      terminalOwnership: 'created',
      hostScope: JSON.stringify(LOCAL_HOST_SCOPE)
    })
    db.markWorkerDispatchReady(started.dispatch.id)
    expect(
      db.settleWorkerReport({
        taskId: task.id,
        dispatchId: started.dispatch.id,
        outcome: 'succeeded',
        result: 'worker succeeded'
      }).action
    ).toBe('settled')

    runtime.prepareLegacyWorkerTerminalRecovery()
    expect(resolveLegacyWorkerTerminalRecovery).toHaveBeenCalledWith(
      WORKER_PANE_KEY,
      'fenced',
      expect.objectContaining({ worktreeId: WORKTREE_ID })
    )
    resolveLegacyWorkerTerminalRecovery.mockClear()
    return started.dispatch.id
  }

  function expectFenceLifted(): void {
    expect(resolveLegacyWorkerTerminalRecovery).toHaveBeenCalledWith(
      WORKER_PANE_KEY,
      'unfenced',
      expect.objectContaining({ worktreeId: WORKTREE_ID })
    )
  }

  it('lifts the fence when release retires the terminal resource', async () => {
    const dispatchId = fenceSettledWorker()

    await expect(
      call('orchestration.workerRelease', { dispatch: dispatchId })
    ).resolves.toMatchObject({
      state: 'released',
      processAction: 'closed_agent_terminal'
    })

    expectFenceLifted()
  })

  it('lifts the fence when the user retains the worker terminal', async () => {
    const dispatchId = fenceSettledWorker()

    await expect(
      call('orchestration.workerRetain', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'retained' })

    expectFenceLifted()
  })

  it('lifts the fence when real user input takes the pane over', async () => {
    fenceSettledWorker()

    await expect(
      call('orchestration.workerTerminalUserInput', {
        paneKey: WORKER_PANE_KEY
      })
    ).resolves.toEqual({ changed: 1 })

    expectFenceLifted()
  })

  it('does not sweep for input on a pane orchestration never owned', async () => {
    fenceSettledWorker()

    await expect(
      call('orchestration.workerTerminalUserInput', {
        paneKey: 'tab_other:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
      })
    ).resolves.toEqual({ changed: 0 })

    expect(resolveLegacyWorkerTerminalRecovery).not.toHaveBeenCalled()
  })
})
