import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { ORCHESTRATION_METHODS } from './orchestration'

describe('manual Dispatch observation', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => db?.close())

  it('covers the real dispatch --inject entry path before observing the lane', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const coordinatorPaneKey = 'tab_coord:leaf_coord'
    const workerPaneKey = 'tab_worker:leaf_worker'
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord' ? coordinatorPaneKey : workerPaneKey
    )
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockReturnValue({
      terminalHandle: 'term_worker',
      paneKey: workerPaneKey,
      processIncarnation: 'runtime_test:term_worker:1'
    } as never)
    vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(true)
    vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
      handle: 'term_worker',
      accepted: true,
      bytesWritten: 1
    })
    vi.spyOn(runtime, 'showTerminal').mockResolvedValue({
      handle: 'term_worker',
      connected: true,
      status: 'running'
    } as never)
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue('runtime_test:term_worker:1')
    vi.spyOn(runtime, 'getTerminalLivenessVerdict').mockReturnValue({
      status: 'live',
      ptyIds: ['runtime_test:term_worker:1']
    })
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    const run = db.createRun({
      objective: 'STA-3848 repro',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey
    })
    const task = db.createTask({ spec: 'injected lane', runId: run.id })
    const dispatchMethod = ORCHESTRATION_METHODS.find(
      (candidate) => candidate.name === 'orchestration.dispatch'
    )
    if (!dispatchMethod) {
      throw new Error('Missing method orchestration.dispatch')
    }

    const result = (await dispatchMethod.handler(
      dispatchMethod.params?.parse({
        task: task.id,
        to: 'term_worker',
        from: 'term_coord',
        run: run.id,
        inject: true
      }),
      { runtime, legacyCoordinatorRunId: run.id }
    )) as { dispatch: { id: string } }

    expect(db.getWorkerDispatch(result.dispatch.id)).toBeUndefined()
    expect(db.getDispatchContextById(result.dispatch.id)).toMatchObject({
      assignee_handle: 'term_worker',
      assignee_pane_key: workerPaneKey,
      process_incarnation: 'runtime_test:term_worker:1',
      capability_hash: expect.any(String)
    })

    const workerShowMethod = ORCHESTRATION_METHODS.find(
      (candidate) => candidate.name === 'orchestration.workerShow'
    )
    if (!workerShowMethod) {
      throw new Error('Missing method orchestration.workerShow')
    }
    await expect(
      workerShowMethod.handler(workerShowMethod.params?.parse({ dispatch: result.dispatch.id }), {
        runtime
      })
    ).resolves.toMatchObject({
      worker: { state: 'unsupervised', stage: 'injected' },
      observation: { status: 'live', exactWorker: true }
    })
  })

  it('keeps context-only reads truthful without supervising the operator pane', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'showTerminal').mockResolvedValue({
      handle: 'term_worker',
      connected: true,
      status: 'running'
    } as never)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue('tab_worker:leaf_worker')
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue('runtime_test:term_worker:1')
    vi.spyOn(runtime, 'readTerminal').mockResolvedValue({
      handle: 'term_worker',
      status: 'running',
      tail: ['injected output'],
      truncated: false,
      nextCursor: null
    })
    const run = db.createRun({
      objective: 'STA-3848 repro',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
    })
    const task = db.createTask({ spec: 'injected lane', runId: run.id })
    const dispatch = db.createDispatchContext(
      task.id,
      'term_worker',
      'tab_worker:leaf_worker',
      'launch-hash',
      'runtime_test:term_worker:1'
    )
    db.mintDispatchCapability({
      dispatchId: dispatch.id,
      paneKey: 'tab_worker:leaf_worker',
      processIncarnation: 'runtime_test:term_worker:1'
    })
    const context = { runtime }
    const call = async (name: string, params: Record<string, unknown>) => {
      const method = ORCHESTRATION_METHODS.find((candidate) => candidate.name === name)
      if (!method) {
        throw new Error(`Missing method ${name}`)
      }
      return method.handler(method.params?.parse(params), context)
    }

    const dispatchShow = (await call('orchestration.dispatchShow', { task: task.id })) as {
      dispatch: {
        id: string
        assignee_handle: string
        assignee_pane_key: string
        process_incarnation: string
      }
    }
    expect(dispatchShow.dispatch).toMatchObject({
      id: dispatch.id,
      assignee_handle: 'term_worker',
      assignee_pane_key: 'tab_worker:leaf_worker',
      process_incarnation: 'runtime_test:term_worker:1'
    })
    expect(db.getWorkerDispatch(dispatch.id)).toBeUndefined()

    const workerList = (await call('orchestration.workerList', { run: run.id })) as {
      workers: {
        dispatchId: string
        workerState: string
        terminalState: string | null
        agentTerminalHandle: string | null
      }[]
    }
    expect(workerList.workers).toEqual([
      expect.objectContaining({
        dispatchId: dispatch.id,
        workerState: 'unsupervised',
        terminalState: 'retained',
        agentTerminalHandle: 'term_worker'
      })
    ])

    await expect(
      call('orchestration.workerShow', { dispatch: dispatch.id })
    ).resolves.toMatchObject({
      worker: { state: 'unsupervised', stage: 'injected', agent_terminal_handle: 'term_worker' },
      observation: { status: 'live', exactWorker: true }
    })
    await expect(
      call('orchestration.workerRead', { dispatch: dispatch.id, source: 'terminal' })
    ).resolves.toMatchObject({
      dispatchId: dispatch.id,
      status: { worker: 'unsupervised' },
      terminal: { tail: ['injected output'] }
    })

    await expect(call('orchestration.workerRetain', { dispatch: dispatch.id })).rejects.toThrow(
      /only a settled dispatch can retain/
    )

    expect(
      db.settleWorkerReport({
        taskId: task.id,
        dispatchId: dispatch.id,
        outcome: 'succeeded',
        result: 'done'
      })
    ).toEqual({ action: 'settled', outcome: 'succeeded', duplicate: false })
    await expect(
      call('orchestration.workerRetain', { dispatch: dispatch.id })
    ).resolves.toMatchObject({
      state: 'retained',
      reason: 'no_owned_resource',
      processAction: 'none'
    })
    await expect(
      call('orchestration.workerRelease', { dispatch: dispatch.id })
    ).resolves.toMatchObject({
      state: 'retained',
      reason: 'no_owned_resource',
      processAction: 'none'
    })
  })

  it.each([
    ['orchestration.workerStop', 'stopped'],
    ['orchestration.workerAbandon', 'abandoned']
  ] as const)('%s fences the assignment without closing the operator pane', async (name, state) => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const closeTerminal = vi.spyOn(runtime, 'closeTerminal')
    const task = db.createTask({ spec: 'operator-owned lane' })
    const dispatch = db.createDispatchContext(
      task.id,
      'term_worker',
      'tab_worker:leaf_worker',
      'launch-hash',
      'runtime_test:term_worker:1'
    )
    const method = ORCHESTRATION_METHODS.find((candidate) => candidate.name === name)

    if (!method) {
      throw new Error(`Missing method ${name}`)
    }
    const result = await method.handler(method.params?.parse({ dispatch: dispatch.id }), {
      runtime
    })

    expect(result).toMatchObject({ state, processAction: 'none' })
    expect(closeTerminal).not.toHaveBeenCalled()
    expect(db.getWorkerDispatch(dispatch.id)).toBeUndefined()
    expect(db.getDispatchContextById(dispatch.id)).toMatchObject({
      status: 'failed',
      last_failure: state
    })
  })
})
