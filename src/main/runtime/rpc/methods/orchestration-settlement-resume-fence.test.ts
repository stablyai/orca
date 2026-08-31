import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_METHODS } from './orchestration'
import type { RpcContext } from '../core'
import { OrchestrationDb } from '../../orchestration/db'
import { OrcaRuntimeService } from '../../orca-runtime'

const COORDINATOR_PANE_KEY = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const WORKER_PANE_KEY = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const WORKTREE_ID = 'repo::worktree'

// Why (STA-4577): the fence only wins the race with a workspace return if settlement itself stamps
// it. These pin the two lifecycle-reconcile call sites that make a settled dispatch observable.
describe('settled worker automatic-resume fence trigger', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
    vi.restoreAllMocks()
  })

  function setup(): {
    ctx: RpcContext
    runId: string
    taskId: string
    dispatchId: string
    resolveLegacyWorkerTerminalRecovery: ReturnType<typeof vi.fn>
  } {
    const orchestrationDb = new OrchestrationDb(':memory:')
    db = orchestrationDb
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(orchestrationDb)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord'
        ? COORDINATOR_PANE_KEY
        : handle === 'term_worker'
          ? WORKER_PANE_KEY
          : null
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
      handle === 'term_worker' ? 'runtime_test:term_worker:1' : null
    )
    vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
    const resolveLegacyWorkerTerminalRecovery = vi.fn()
    runtime.setNotifier({ resolveLegacyWorkerTerminalRecovery } as never)

    const run = orchestrationDb.createRun({
      objective: 'Settlement fence run',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: COORDINATOR_PANE_KEY
    })
    const task = orchestrationDb.createTask({ spec: 'settle me', runId: run.id })
    const started = orchestrationDb.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    const orchestrationCapability = orchestrationDb.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_worker',
      paneKey: WORKER_PANE_KEY,
      processIncarnation: 'runtime_test:term_worker:1',
      worktreeId: WORKTREE_ID,
      setupState: 'not_applicable',
      effects: [],
      terminalOwnership: 'created'
    })
    orchestrationDb.markWorkerDispatchReady(started.dispatch.id)
    return {
      ctx: { runtime, orchestrationCapability },
      runId: run.id,
      taskId: task.id,
      dispatchId: started.dispatch.id,
      resolveLegacyWorkerTerminalRecovery
    }
  }

  async function call(
    name: string,
    params: Record<string, unknown>,
    ctx: RpcContext
  ): Promise<unknown> {
    const method = ORCHESTRATION_METHODS.find((entry) => entry.name === name)
    if (!method) {
      throw new Error(`Method not found: ${name}`)
    }
    return method.handler(method.params ? method.params.parse(params) : undefined, ctx)
  }

  function workerDonePayload(taskId: string, dispatchId: string): string {
    return JSON.stringify({ taskId, dispatchId, outcome: 'succeeded' })
  }

  it('fences the pane when orchestration.send settles the worker_done', async () => {
    const fixture = setup()

    const sent = (await call(
      'orchestration.send',
      {
        from: 'term_worker',
        to: `run:${fixture.runId}`,
        subject: 'Done',
        type: 'worker_done',
        payload: workerDonePayload(fixture.taskId, fixture.dispatchId),
        run: fixture.runId
      },
      fixture.ctx
    )) as { lifecycle?: { action: string } }

    expect(sent.lifecycle?.action).toBe('completed')
    expect(fixture.resolveLegacyWorkerTerminalRecovery).toHaveBeenCalledWith(
      WORKER_PANE_KEY,
      'fenced',
      { worktreeId: WORKTREE_ID }
    )
  })

  it('fences the pane when an unread check is the first to settle the worker_done', async () => {
    const fixture = setup()
    // A direct-handle mailbox: `check` is the authoritative read that reconciles this worker_done.
    db?.insertMessage({
      from: 'term_worker',
      to: 'term_watcher',
      subject: 'Done',
      type: 'worker_done',
      payload: workerDonePayload(fixture.taskId, fixture.dispatchId),
      senderPaneKey: WORKER_PANE_KEY,
      runId: fixture.runId
    })

    await call('orchestration.check', { terminal: 'term_watcher' }, fixture.ctx)

    expect(fixture.resolveLegacyWorkerTerminalRecovery).toHaveBeenCalledWith(
      WORKER_PANE_KEY,
      'fenced',
      { worktreeId: WORKTREE_ID }
    )
  })

  it('does not fence anything for a heartbeat that settles nothing', async () => {
    const fixture = setup()

    await call(
      'orchestration.send',
      {
        from: 'term_worker',
        to: `run:${fixture.runId}`,
        subject: 'Still working',
        type: 'heartbeat',
        payload: JSON.stringify({ dispatchId: fixture.dispatchId }),
        run: fixture.runId
      },
      fixture.ctx
    )

    expect(fixture.resolveLegacyWorkerTerminalRecovery).not.toHaveBeenCalled()
  })
})
