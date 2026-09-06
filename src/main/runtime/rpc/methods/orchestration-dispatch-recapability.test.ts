import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { ORCHESTRATION_METHODS } from './orchestration'

// Why: a crashed agent takes its capability to the grave. The coordinator
// must be able to re-authorize the replacement agent in the same terminal
// without fencing the dispatch and losing its history.
describe('dispatch recapability after agent crash', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => db?.close())

  function harness(incarnation: string, withSecondRun = false) {
    db = new OrchestrationDb(':memory:')
    const paneFor = (handle: string) =>
      handle === 'term_coord' ? 'tab_coord:leaf_coord'
      : withSecondRun && handle === 'term_other' ? 'tab_other:leaf_other'
      : 'tab_worker:leaf_worker'
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation(paneFor)
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockReturnValue({
      terminalHandle: 'term_worker',
      paneKey: 'tab_worker:leaf_worker',
      processIncarnation: incarnation
    } as never)
    vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(true)
    vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
      handle: 'term_worker',
      accepted: true,
      bytesWritten: 1
    })
    vi.spyOn(runtime, 'getNestedWorkerMaxDepth').mockReturnValue(3)
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    const run = db.createRun({ objective: 'recap', coordinatorHandle: 'term_coord', coordinatorPaneKey: 'tab_coord:leaf_coord' })
    if (withSecondRun) {
      db.createRun({ objective: 'other', coordinatorHandle: 'term_other', coordinatorPaneKey: 'tab_other:leaf_other' })
    }
    const task = db.createTask({ spec: 'crash me', runId: run.id })
    const find = (name: string) => {
      const m = ORCHESTRATION_METHODS.find((c) => c.name === name)
      if (!m) throw new Error(`Missing method ${name}`)
      return m
    }
    return { runtime, run, task, find }
  }

  function tokenOf(preamble: string): string {
    const m = /--dispatch-capability (dcap_\S+)/.exec(preamble)
    if (!m) throw new Error('preamble carries no capability')
    return m[1]
  }

  it('rotates the secret so the zombie loses authority and the replacement gains it', async () => {
    const { runtime, run, task, find } = harness('runtime_test:term_worker:1')
    const dispatch = find('orchestration.dispatch')
    const created = (await dispatch.handler(
      dispatch.params?.parse({ task: task.id, to: 'term_worker', from: 'term_coord', run: run.id, inject: true, returnPreamble: true }),
      { runtime } as never
    )) as { dispatch: { id: string }; preamble: string }
    const oldToken = tokenOf(created.preamble)
    expect(
      db!.verifyDispatchCapability({ dispatchId: created.dispatch.id, capability: oldToken, paneKey: 'tab_worker:leaf_worker', processIncarnation: 'runtime_test:term_worker:1' })
    ).toEqual({ valid: true })
    // Crash: replacement agent runs under a new incarnation.
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockReturnValue({
      terminalHandle: 'term_worker',
      paneKey: 'tab_worker:leaf_worker',
      processIncarnation: 'runtime_test:term_worker:2'
    } as never)
    const show = find('orchestration.dispatchShow')
    const result = (await show.handler(
      show.params?.parse({ task: task.id, preamble: true, recapability: true, from: 'term_coord' }),
      { runtime } as never
    )) as { preamble: string }
    const newToken = tokenOf(result.preamble)
    expect(newToken).not.toBe(oldToken)
    expect(
      db!.verifyDispatchCapability({ dispatchId: created.dispatch.id, capability: oldToken, paneKey: 'tab_worker:leaf_worker', processIncarnation: 'runtime_test:term_worker:1' })
    ).toMatchObject({ valid: false })
    expect(
      db!.verifyDispatchCapability({ dispatchId: created.dispatch.id, capability: newToken, paneKey: 'tab_worker:leaf_worker', processIncarnation: 'runtime_test:term_worker:2' })
    ).toEqual({ valid: true })
  })

  it('refuses recapability once the dispatch settled', () => {
    const { runtime, run, task, find } = harness('runtime_test:term_worker:1')
    const dispatch = find('orchestration.dispatch')
    let created: { dispatch: { id: string } } | undefined
    const runFlow = async () => {
      created = (await dispatch.handler(
        dispatch.params?.parse({ task: task.id, to: 'term_worker', from: 'term_coord', run: run.id, inject: false }),
        { runtime } as never
      )) as { dispatch: { id: string } }
    }
    return runFlow().then(() => {
      db!.completeDispatch(created!.dispatch.id)
      const show = find('orchestration.dispatchShow')
      let err: unknown
      try {
        show.handler(
          show.params?.parse({ task: task.id, preamble: true, recapability: true, from: 'term_coord' }),
          { runtime } as never
        )
      } catch (e) { err = e }
      expect(err).toMatchObject({ code: 'dispatch_not_active' })
    })
  })

  it('refuses recapability without a stable pane', () => {
    const { runtime, run, task, find } = harness('runtime_test:term_worker:1')
    const dispatch = find('orchestration.dispatch')
    let done = false
    const runFlow = async () => {
      await dispatch.handler(
        dispatch.params?.parse({ task: task.id, to: 'term_worker', from: 'term_coord', run: run.id, inject: false }),
        { runtime } as never
      )
      done = true
    }
    return runFlow().then(() => {
      expect(done).toBe(true)
      vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(undefined)
      vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockReturnValue(undefined as never)
      const show = find('orchestration.dispatchShow')
      let err: unknown
      try {
        show.handler(
          show.params?.parse({ task: task.id, preamble: true, recapability: true, from: 'term_coord' }),
          { runtime } as never
        )
      } catch (e) { err = e }
      expect(err).toMatchObject({ code: 'stable_pane_required' })
    })
  })

  it('refuses recapability from a terminal bound to another run', () => {
    // Second run owned by another coordinator terminal: the caller is
    // bound, but not to THIS task's run.
    const { runtime, run, task, find } = harness('runtime_test:term_worker:1', true)
    const dispatch = find('orchestration.dispatch')
    const runFlow = async () => {
      await dispatch.handler(
        dispatch.params?.parse({ task: task.id, to: 'term_worker', from: 'term_coord', run: run.id, inject: false }),
        { runtime } as never
      )
    }
    return runFlow().then(() => {
      const show = find('orchestration.dispatchShow')
      let err: unknown
      try {
        show.handler(
          show.params?.parse({ task: task.id, preamble: true, recapability: true, from: 'term_other' }),
          { runtime } as never
        )
      } catch (e) { err = e }
      expect(err).toMatchObject({ code: 'consumer_fenced' })
    })
  })
})
