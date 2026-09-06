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

  function harness(incarnation: string) {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue('tab_worker:leaf_worker')
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockReturnValue({
      terminalHandle: 'term_worker',
      paneKey: 'tab_worker:leaf_worker',
      processIncarnation: incarnation
    } as never)
    vi.spyOn(runtime, 'getNestedWorkerMaxDepth').mockReturnValue(3)
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    const run = db.createRun({ objective: 'recap', coordinatorHandle: 'term_coord', coordinatorPaneKey: 'tab_coord:leaf_coord' })
    const task = db.createTask({ spec: 'crash me', runId: run.id })
    const find = (name: string) => {
      const m = ORCHESTRATION_METHODS.find((c) => c.name === name)
      if (!m) throw new Error(`Missing method ${name}`)
      return m
    }
    return { runtime, run, task, find }
  }

  it('re-mints capability against the current incarnation and embeds it', async () => {
    const { runtime, run, task, find } = harness('runtime_test:term_worker:1')
    const dispatch = find('orchestration.dispatch')
    await dispatch.handler(
      dispatch.params?.parse({ task: task.id, to: 'term_worker', from: 'term_coord', run: run.id, inject: false }),
      { runtime } as never
    )
    // Crash: the incarnation recorded at dispatch time is now dead; the
    // replacement agent runs under a new one.
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
    expect(result.preamble).toContain('--dispatch-capability dcap_')
    expect(result.preamble).toContain('--from term_worker')
  })

  it('refuses recapability once the dispatch settled', async () => {
    const { runtime, run, task, find } = harness('runtime_test:term_worker:1')
    const dispatch = find('orchestration.dispatch')
    const created = (await dispatch.handler(
      dispatch.params?.parse({ task: task.id, to: 'term_worker', from: 'term_coord', run: run.id, inject: false }),
      { runtime } as never
    )) as { dispatch: { id: string } }
    db!.completeDispatch(created.dispatch.id)
    const show = find('orchestration.dispatchShow')
    await expect(
      show.handler(
        show.params?.parse({ task: task.id, preamble: true, recapability: true, from: 'term_coord' }),
        { runtime } as never
      )
    ).rejects.toMatchObject({ code: 'dispatch_not_active' })
  })

  it('refuses recapability without a stable pane', async () => {
    const { runtime, run, task, find } = harness('runtime_test:term_worker:1')
    const dispatch = find('orchestration.dispatch')
    await dispatch.handler(
      dispatch.params?.parse({ task: task.id, to: 'term_worker', from: 'term_coord', run: run.id, inject: false }),
      { runtime } as never
    )
    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(undefined)
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockReturnValue(undefined as never)
    const show = find('orchestration.dispatchShow')
    await expect(
      show.handler(
        show.params?.parse({ task: task.id, preamble: true, recapability: true, from: 'term_coord' }),
        { runtime } as never
      )
    ).rejects.toMatchObject({ code: 'stable_pane_required' })
  })
})
