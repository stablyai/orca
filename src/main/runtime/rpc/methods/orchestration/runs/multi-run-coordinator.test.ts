import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'
import { COORDINATOR_PANE_KEY, createOrchestrationRpcHarness } from '../rpc-test-harness'

const OTHER_PANE_KEY = 'tab_other:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

describe('a coordinator that creates a second Run', () => {
  const h = createOrchestrationRpcHarness()
  afterEach(() => h.cleanup())

  function setupTwoRuns() {
    const state = h.setup()
    const runA = state.activeRunId!
    const dispatch = createRootDispatch(
      state.db,
      state.db.createTask({ spec: 'A work', runId: runA }).id,
      'term_worker'
    )
    return { ...state, runA, dispatch }
  }

  async function createRunB(state: ReturnType<typeof h.setup>): Promise<string> {
    await h.call('orchestration.runCreate', { from: 'term_coord', objective: 'B' }, state.ctx)
    return state.db.getCurrentRunForPane(COORDINATOR_PANE_KEY)!.id
  }

  it('keeps reading, answering and sending in its earlier Run', async () => {
    const state = setupTwoRuns()
    const { db, ctx, runA, dispatch } = state
    const report = db.insertMessage({
      from: 'term_worker',
      to: `run:${runA}`,
      runId: runA,
      subject: 'A report',
      type: 'worker_done'
    })
    const question = db.createQuestion({
      runId: runA,
      dispatchId: dispatch.id,
      askerHandle: 'term_worker',
      question: 'Proceed?'
    })
    const runB = await createRunB(state)

    expect(
      await h.call('orchestration.check', { terminal: 'term_coord', run: runA }, ctx)
    ).toMatchObject({
      runId: runA,
      messages: expect.arrayContaining([expect.objectContaining({ id: report.id })])
    })
    expect(
      await h.call(
        'orchestration.reply',
        { id: question.message.id, body: 'Yes', from: 'term_coord' },
        ctx
      )
    ).toMatchObject({ duplicate: false })
    expect(
      await h.call(
        'orchestration.send',
        { from: 'term_coord', run: runA, to: `dispatch:${dispatch.id}`, subject: 'more' },
        ctx
      )
    ).toMatchObject({ message: { run_id: runA } })
    // Plain check and implicit scope follow the newest Run.
    expect(await h.call('orchestration.check', { terminal: 'term_coord' }, ctx)).toMatchObject({
      runId: runB
    })
  })

  it('ends a wait on the earlier Run when run-use keeps only another Run', async () => {
    const state = setupTwoRuns()
    const { ctx, runtime, runA } = state
    const runB = await createRunB(state)
    const waitSpy = vi.spyOn(runtime, 'waitForMessage')
    const waiting = h.call(
      'orchestration.check',
      { terminal: 'term_coord', run: runA, wait: true, timeoutMs: 60_000 },
      ctx
    )
    await vi.waitFor(() => expect(waitSpy).toHaveBeenCalled())

    await h.call('orchestration.runUse', { from: 'term_coord', id: runB }, ctx)

    await expect(waiting).rejects.toMatchObject({ code: 'consumer_fenced' })
  })

  it('still loses the earlier Run when another coordinator takes it over', async () => {
    const state = setupTwoRuns()
    const { db, ctx, runtime, runA } = state
    await createRunB(state)
    vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_coord'
        ? COORDINATOR_PANE_KEY
        : handle === 'term_other'
          ? OTHER_PANE_KEY
          : null
    )
    await h.call('orchestration.runUse', { from: 'term_other', id: runA }, ctx)

    await expect(
      h.call('orchestration.check', { terminal: 'term_coord', run: runA }, ctx)
    ).rejects.toMatchObject({ code: 'consumer_fenced' })
    expect(db.getRun(runA)?.coordinator_handle).toBe('term_other')
  })
})
