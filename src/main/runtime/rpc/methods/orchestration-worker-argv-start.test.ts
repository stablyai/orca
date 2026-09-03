import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { reconcileLifecycleMessage } from '../../orchestration/lifecycle-reconciliation'
import { startArgvWorkerDispatch } from './orchestration-worker-argv-start'

type TerminalWait = Awaited<ReturnType<OrcaRuntimeService['waitForTerminal']>>

describe('argv worker startup readiness monitor', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  function startDispatch() {
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'argv startup monitor',
      coordinatorHandle: 'term-coord',
      coordinatorPaneKey: 'tab-coord:leaf-coord'
    })
    const task = db.createTask({ spec: 'argv startup task', runId: run.id })
    const started = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    return { run, task, dispatchId: started.dispatch.id }
  }

  function startMonitor(
    dispatchId: string,
    waitForTerminal: () => Promise<TerminalWait>,
    options: { insertMessage?: ReturnType<typeof vi.fn>; settle?: () => void } = {}
  ) {
    const insertMessage = options.insertMessage ?? vi.spyOn(db!, 'insertMessage')
    let launchTokenHash: string | null = null
    const runtime = {
      createPreAllocatedTerminalHandle: vi.fn(() => 'term-worker'),
      getTerminalPaneKey: vi.fn(() => 'tab-worker:leaf-worker'),
      getTerminalProcessIncarnation: vi.fn(() => 'runtime:worker:1'),
      getOrchestrationDispatchAuthority: vi.fn(() => ({
        paneKey: 'tab-worker:leaf-worker',
        processIncarnation: 'runtime:worker:1',
        ...(launchTokenHash ? { launchTokenHash } : {})
      })),
      createTerminal: vi.fn(async (_selector: string, opts?: { launchToken?: string }) => {
        launchTokenHash = opts?.launchToken
          ? createHash('sha256').update(opts.launchToken).digest('hex')
          : null
        return { handle: 'term-worker', worktreeId: 'repo::worker' }
      }),
      getWorktreeOrchestrationCliCommand: vi.fn(async () => 'orca'),
      waitForTerminal: vi.fn(waitForTerminal),
      notifyMessageArrived: vi.fn()
    } as unknown as OrcaRuntimeService
    const task = db!.getTask(db!.getDispatchContextById(dispatchId)!.task_id)!
    const pending = startArgvWorkerDispatch({
      runtime,
      db: db!,
      runId: task.run_id,
      task,
      dispatchId,
      coordinatorHandle: 'term-coord',
      timeoutMs: 1_000,
      agent: 'codex',
      launchReceipt: {} as never,
      worktreeId: 'repo::worker',
      effects: [],
      setupReceipt: {
        requested: 'not_applicable',
        effective: 'not_applicable',
        source: 'existing_worktree',
        hookFound: false,
        startupPolicy: 'start-immediately',
        state: 'not_applicable'
      },
      onStage: () => undefined
    })
    return { pending, runtime, insertMessage }
  }

  it('does not publish after worker_done settles before an unsatisfied wait returns', async () => {
    const { run, task, dispatchId } = startDispatch()
    let finishWait!: (value: TerminalWait) => void
    const insertMessage = vi.spyOn(db!, 'insertMessage')
    const { pending } = startMonitor(
      dispatchId,
      () => new Promise((resolve) => (finishWait = resolve)),
      { insertMessage }
    )
    const started = await pending
    const message = db!.insertMessage({
      runId: run.id,
      from: 'term-worker',
      to: `run:${run.id}`,
      subject: 'Completed immediately',
      type: 'worker_done',
      payload: JSON.stringify({ taskId: task.id, dispatchId, outcome: 'succeeded' }),
      senderPaneKey: 'tab-worker:leaf-worker'
    })
    expect(reconcileLifecycleMessage(db!, message)).toMatchObject({ action: 'completed' })
    insertMessage.mockClear()
    finishWait({
      handle: 'term-worker',
      condition: 'tui-idle',
      satisfied: false,
      status: 'running',
      exitCode: null
    })
    await vi.waitFor(() => expect(db!.getDispatchContextById(dispatchId)?.status).toBe('completed'))
    await Promise.resolve()
    expect(insertMessage).not.toHaveBeenCalled()
    expect(started.state).toBe('ready')
  })

  it('publishes a timeout rejection as durable blocked evidence while ready', async () => {
    const { dispatchId } = startDispatch()
    const insertMessage = vi.spyOn(db!, 'insertMessage')
    startMonitor(dispatchId, () => Promise.reject(new Error('timeout')), { insertMessage })

    await vi.waitFor(() => {
      expect(insertMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          priority: 'high',
          payload: expect.stringContaining('Terminal readiness wait failed: timeout')
        })
      )
    })
  })

  it('publishes terminal exit as durable blocked evidence while ready', async () => {
    const { dispatchId } = startDispatch()
    const insertMessage = vi.spyOn(db!, 'insertMessage')
    startMonitor(
      dispatchId,
      () =>
        Promise.resolve({
          handle: 'term-worker',
          condition: 'tui-idle',
          satisfied: false,
          status: 'exited',
          exitCode: 1
        }),
      { insertMessage }
    )

    await vi.waitFor(() => {
      expect(insertMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          priority: 'high',
          payload: expect.stringContaining('Terminal readiness wait failed: terminal_exited')
        })
      )
    })
  })

  it.each(['request_aborted', 'terminal_handle_stale'] as const)(
    'does not publish a %s rejection',
    async (reason) => {
      const { dispatchId } = startDispatch()
      const insertMessage = vi.spyOn(db!, 'insertMessage')
      startMonitor(dispatchId, () => Promise.reject(new Error(reason)), { insertMessage })

      await Promise.resolve()
      await Promise.resolve()
      expect(insertMessage).not.toHaveBeenCalled()
    }
  )
})
