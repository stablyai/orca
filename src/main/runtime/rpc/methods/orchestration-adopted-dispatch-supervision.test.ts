import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_METHODS } from './orchestration'
import type { RpcContext } from '../core'
import { OrchestrationDb } from '../../orchestration/db'
import { OrcaRuntimeService } from '../../orca-runtime'

const COORDINATOR_PANE_KEY = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const WORKER_PANE_KEY = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const WORKER_INCARNATION = 'runtime_test:term_worker:1'

describe('dispatch --inject --supervise adopts a running agent as a supervised worker', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let ctx: RpcContext
  let runId: string

  async function call(name: string, params: Record<string, unknown>): Promise<unknown> {
    const method = ORCHESTRATION_METHODS.find((candidate) => candidate.name === name)
    if (!method) {
      throw new Error(`Method not found: ${name}`)
    }
    return method.handler(method.params ? method.params.parse(params) : undefined, ctx)
  }

  async function dispatchToWorker(
    taskId: string,
    extra: Record<string, unknown> = {}
  ): Promise<{ dispatch: { id: string }; injected: boolean; supervised: boolean }> {
    return (await call('orchestration.dispatch', {
      task: taskId,
      to: 'term_worker',
      from: 'term_coord',
      run: runId,
      inject: true,
      ...extra
    })) as { dispatch: { id: string }; injected: boolean; supervised: boolean }
  }

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_worker' ? WORKER_PANE_KEY : COORDINATOR_PANE_KEY
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
      handle === 'term_worker' ? WORKER_INCARNATION : null
    )
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) =>
      handle === 'term_worker'
        ? ({
            terminalHandle: 'term_worker',
            paneKey: WORKER_PANE_KEY,
            processIncarnation: WORKER_INCARNATION,
            launchTokenHash: null,
            hostScope: { kind: 'local', hostId: 'local' }
          } as never)
        : null
    )
    vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(true)
    vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
      handle: 'term_worker',
      accepted: true,
      bytesWritten: 1
    })
    vi.spyOn(runtime, 'showTerminal').mockImplementation(
      async (handle: string) => ({ handle, worktreeId: 'wt_worker', connected: true }) as never
    )
    runId = db.createRun({
      objective: 'Adopted wave',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: COORDINATOR_PANE_KEY
    }).id
    ctx = { runtime }
  })

  afterEach(() => {
    db.close()
    vi.restoreAllMocks()
  })

  it('records a ready worker that worker-show and worker-list report', async () => {
    const task = db.createTask({ spec: 'work', runId })

    const dispatched = await dispatchToWorker(task.id, { supervise: true })
    expect(dispatched.supervised).toBe(true)

    const shown = (await call('orchestration.workerShow', {
      dispatch: dispatched.dispatch.id
    })) as {
      worker: { state: string; stage: string; agent_terminal_handle: string; worktree_id: string }
      observation: { exactWorker: boolean; status: string }
    }
    expect(shown.worker).toMatchObject({
      state: 'ready',
      stage: 'input_accepted',
      agent_terminal_handle: 'term_worker',
      worktree_id: 'wt_worker'
    })
    expect(shown.observation).toMatchObject({ exactWorker: true, status: 'running' })

    const listed = (await call('orchestration.workerList', { run: runId })) as {
      workers: { dispatchId: string; agentTerminalHandle: string }[]
    }
    expect(listed.workers).toEqual([
      expect.objectContaining({
        dispatchId: dispatched.dispatch.id,
        agentTerminalHandle: 'term_worker'
      })
    ])
  })

  it('leaves the injected pane untouched while recording it', async () => {
    const task = db.createTask({ spec: 'work', runId })
    const closeTerminal = vi.spyOn(runtime, 'closeTerminal')
    const createTerminal = vi.spyOn(runtime, 'createTerminal')

    await dispatchToWorker(task.id, { supervise: true })

    // The pane is already running the operator's agent, so supervision must not restart or re-prompt it.
    expect(runtime.sendTerminalAgentPrompt).toHaveBeenCalledTimes(1)
    expect(closeTerminal).not.toHaveBeenCalled()
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('records the adopted terminal as external so release never closes it', async () => {
    const task = db.createTask({ spec: 'work', runId })
    const closeTerminal = vi.spyOn(runtime, 'closeTerminal')

    const dispatched = await dispatchToWorker(task.id, { supervise: true })
    db.settleWorkerReport({
      taskId: task.id,
      dispatchId: dispatched.dispatch.id,
      outcome: 'succeeded',
      result: 'done'
    })

    const released = (await call('orchestration.workerRelease', {
      dispatch: dispatched.dispatch.id
    })) as { state: string; reason?: string; processAction: string }
    expect(released).toMatchObject({
      state: 'retained',
      reason: 'external_terminal',
      processAction: 'none'
    })
    expect(closeTerminal).not.toHaveBeenCalled()
  })

  it('settles the adopted worker through the ordinary worker report path', async () => {
    const task = db.createTask({ spec: 'work', runId })
    const dispatched = await dispatchToWorker(task.id, { supervise: true })

    db.settleWorkerReport({
      taskId: task.id,
      dispatchId: dispatched.dispatch.id,
      outcome: 'succeeded',
      result: 'done'
    })

    expect(db.getWorkerDispatch(dispatched.dispatch.id)).toMatchObject({
      state: 'succeeded',
      stage: 'settled'
    })
  })

  it('leaves a plain --inject dispatch unsupervised', async () => {
    const task = db.createTask({ spec: 'work', runId })

    const dispatched = await dispatchToWorker(task.id)

    expect(dispatched).toMatchObject({ injected: true, supervised: false })
    expect(db.getWorkerDispatch(dispatched.dispatch.id)).toBeUndefined()
    await expect(
      call('orchestration.workerShow', { dispatch: dispatched.dispatch.id })
    ).rejects.toThrow(`Worker Dispatch ${dispatched.dispatch.id} was not found.`)
  })

  it('rejects --supervise without --inject', async () => {
    const task = db.createTask({ spec: 'work', runId })

    await expect(
      call('orchestration.dispatch', {
        task: task.id,
        to: 'term_worker',
        from: 'term_coord',
        run: runId,
        supervise: true
      })
    ).rejects.toThrow('--supervise requires --inject')
    expect(db.getTask(task.id)?.status).toBe('ready')
  })

  it('downgrades to unsupervised instead of failing a delivered dispatch', async () => {
    const task = db.createTask({ spec: 'work', runId })
    vi.spyOn(db, 'attachSupervisedWorkerToDispatch').mockImplementation(() => {
      throw new Error('record write lost a race')
    })

    const dispatched = (await dispatchToWorker(task.id, { supervise: true })) as {
      injected: boolean
      supervised: boolean
      superviseError?: string
    }

    // The preamble is already in the worker's input and cannot be recalled.
    expect(dispatched).toMatchObject({ injected: true, supervised: false })
    expect(dispatched.superviseError).toBe('record write lost a race')
  })

  it('does not supervise when injection fails', async () => {
    const task = db.createTask({ spec: 'work', runId })
    vi.mocked(runtime.sendTerminalAgentPrompt).mockRejectedValue(new Error('terminal_not_writable'))

    await expect(dispatchToWorker(task.id, { supervise: true })).rejects.toThrow(
      'terminal_not_writable'
    )
    expect(db.getActiveDispatchForTerminal('term_worker')).toBeUndefined()
  })
})
