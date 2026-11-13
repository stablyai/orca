import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../../../../orca-runtime'
import { OrchestrationDb } from '../../../../../orchestration/db/orchestration-db'
import '../../../../../orchestration/db/contract-constants'
import '../../../../../orchestration/db/messages/mailbox-routing-page'
import '../../../../../orchestration/db/dispatch-row-writer'
import '../../../../../orchestration/db/attempt-outcome-projection'
import { ORCHESTRATION_METHODS } from '../../orchestration'
import { createRootDispatch } from '../../../../../orchestration/db/root-dispatch-test-fixture'
import { isStreamingMethod, eraseRpcMethods } from '../../../../core'

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
    // Authority is per handle in the real runtime; a flat mock would give the coordinator the worker's pane.
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation(
      (handle) =>
        ({
          terminalHandle: handle,
          paneKey: handle === 'term_coord' ? coordinatorPaneKey : workerPaneKey,
          processIncarnation:
            handle === 'term_coord' ? 'runtime_test:term_coord:1' : 'runtime_test:term_worker:1'
        }) as never
    )
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
    const dispatchMethod = eraseRpcMethods(ORCHESTRATION_METHODS).find(
      (candidate) => candidate.name === 'orchestration.dispatch'
    )
    if (!dispatchMethod || isStreamingMethod(dispatchMethod)) {
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
      process_incarnation: 'runtime_test:term_worker:1'
    })

    const workerShowMethod = eraseRpcMethods(ORCHESTRATION_METHODS).find(
      (candidate) => candidate.name === 'orchestration.workerShow'
    )
    if (!workerShowMethod || isStreamingMethod(workerShowMethod)) {
      throw new Error('Missing method orchestration.workerShow')
    }
    await expect(
      workerShowMethod.handler(workerShowMethod.params?.parse({ dispatch: result.dispatch.id }), {
        runtime
      })
    ).resolves.toMatchObject({
      worker: { state: 'unsupervised', stage: 'context_only' },
      observation: { status: 'live', exactWorker: true }
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
    const task = db.createTask({
      runId: 'run_legacy_local',
      spec: 'operator-owned lane'
    })
    const dispatch = createRootDispatch(
      db,
      task.id,
      'term_worker',
      'tab_worker:leaf_worker',
      'launch-hash',
      'runtime_test:term_worker:1'
    )
    const method = eraseRpcMethods(ORCHESTRATION_METHODS).find(
      (candidate) => candidate.name === name
    )

    if (!method || isStreamingMethod(method)) {
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
