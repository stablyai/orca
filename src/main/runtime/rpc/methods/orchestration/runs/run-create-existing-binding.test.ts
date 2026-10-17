import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'

describe('run-create with an existing coordinator binding', () => {
  const h = createOrchestrationRpcHarness()

  afterEach(() => {
    h.cleanup()
    vi.restoreAllMocks()
  })

  it.each([undefined, false, 'true'])(
    'refuses replacement with %s without changing the mailbox or waiters',
    async (replaceCurrent) => {
      const { db, runtime, ctx, activeRunId } = h.setup()
      if (!activeRunId) {
        throw new Error('Expected the fixture to bind a Run')
      }
      const prior = db.getRun(activeRunId)
      const runs = db.listRuns()
      const message = db.insertMessage({
        from: 'term_worker',
        to: `run:${activeRunId}`,
        subject: 'Review needed'
      })
      const cancel = vi.spyOn(runtime, 'cancelMessageWaiters')

      await expect(
        h.call(
          'orchestration.runCreate',
          { objective: 'Unrelated probe', from: 'term_coord', replaceCurrent },
          ctx
        )
      ).rejects.toMatchObject({
        code: 'run_already_bound',
        data: { effectsApplied: false, runId: activeRunId }
      })

      expect(db.listRuns()).toEqual(runs)
      expect(db.getRun(activeRunId)).toEqual(prior)
      expect(db.getCurrentRunForPane(h.coordinatorPaneKey)?.id).toBe(activeRunId)
      expect(db.getMessageById(message.id)).toMatchObject({ run_id: activeRunId, read: 0 })
      expect(cancel).not.toHaveBeenCalled()
    }
  )

  it('recognizes a restored pane with a reminted terminal handle', async () => {
    const { db, runtime, ctx, activeRunId } = h.setup()
    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(h.coordinatorPaneKey)

    await expect(
      h.call(
        'orchestration.runCreate',
        {
          objective: 'Restored coordinator',
          from: 'term_restored'
        },
        ctx
      )
    ).rejects.toMatchObject({ code: 'run_already_bound', data: { runId: activeRunId } })
    expect(db.getCurrentRunForPane(h.coordinatorPaneKey)?.id).toBe(activeRunId)
  })

  it('keeps an existing waiter alive after refusing creation', async () => {
    const { ctx, activeRunId } = h.setup()
    const waiting = h.call(
      'orchestration.check',
      {
        terminal: 'term_coord',
        wait: true,
        timeoutMs: 5_000
      },
      ctx
    )
    const delivered = expect(waiting).resolves.toMatchObject({
      runId: activeRunId,
      messages: [{ subject: 'Still connected' }]
    })
    await Promise.resolve()

    await expect(
      h.call(
        'orchestration.runCreate',
        {
          objective: 'Probe',
          from: 'term_coord'
        },
        ctx
      )
    ).rejects.toMatchObject({ code: 'run_already_bound' })
    await h.call(
      'orchestration.send',
      {
        from: 'term_worker',
        to: `run:${activeRunId}`,
        subject: 'Still connected'
      },
      ctx
    )
    await delivered
  })

  it('explicitly replaces the binding and fences the old waiter', async () => {
    const { db, ctx, activeRunId } = h.setup()
    if (!activeRunId) {
      throw new Error('Expected the fixture to bind a Run')
    }
    const generation = db.getRun(activeRunId)?.consumer_generation
    const waiting = h.call(
      'orchestration.check',
      {
        terminal: 'term_coord',
        wait: true,
        timeoutMs: 5_000
      },
      ctx
    )
    const fenced = expect(waiting).rejects.toMatchObject({ code: 'consumer_fenced' })
    await Promise.resolve()

    await h.call(
      'orchestration.runCreate',
      {
        objective: 'Replacement',
        from: 'term_coord',
        replaceCurrent: true
      },
      ctx
    )
    await fenced
    expect(db.getCurrentRunForPane(h.coordinatorPaneKey)).toMatchObject({
      objective: 'Replacement'
    })
    expect(db.getRun(activeRunId)).toMatchObject({
      coordinator_handle: null,
      coordinator_pane_key: null,
      consumer_generation: (generation ?? 0) + 1
    })
  })
})
