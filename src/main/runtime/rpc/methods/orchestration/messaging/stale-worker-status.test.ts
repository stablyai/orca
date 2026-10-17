import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOrchestrationRpcHarness, type OrchestrationRpcState } from '../rpc-test-harness'
import { startRpcWorker, WORKER_PANE } from '../rpc-worker-authority-test-fixture'

describe('explicit inactive worker status admission', () => {
  const h = createOrchestrationRpcHarness()
  let s: OrchestrationRpcState
  let runId: string
  let worker: ReturnType<typeof startRpcWorker>
  beforeEach(() => {
    s = h.setup()
    runId = s.activeRunId!
    vi.mocked(s.runtime.getTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_worker'
        ? WORKER_PANE
        : handle === 'term_coord'
          ? h.coordinatorPaneKey
          : handle === 'term_teammate'
            ? 'tab_teammate:dddddddd-dddd-4ddd-8ddd-dddddddddddd'
            : null
    )
    worker = startRpcWorker(s.db, runId)
  })
  afterEach(() => {
    s.runtime.cancelMessageWaiters(`run:${runId}`)
    h.cleanup()
  })
  function send(params: Record<string, unknown> = {}) {
    return h.call(
      'orchestration.send',
      {
        from: 'term_worker',
        type: 'status',
        subject: 'Worker status',
        payload: JSON.stringify(worker),
        ...params
      },
      s.ctx
    )
  }
  function abandon() {
    s.db.abandonWorkerDispatch(worker.dispatchId, 'owned-test-epoch')
  }
  function unread() {
    return s.db.getUnreadMessages(`run:${runId}`)
  }

  it('consumes stale status without waking a Run waiter and delivers fresh owned status', async () => {
    abandon()
    const notify = vi.spyOn(s.runtime, 'notifyMessageArrived')
    const waiting = s.runtime.waitForMessage(`run:${runId}`, {
      timeoutMs: 5000,
      typeFilter: ['status']
    })
    await send({ type: 'heartbeat', subject: 'Old heartbeat' })
    await send({ subject: 'Abandoned status' })
    expect(unread()).toEqual([])
    expect(notify).not.toHaveBeenCalled()
    expect(s.db.getInbox()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subject: 'Abandoned status',
          read: 1,
          delivered_at: expect.any(String)
        })
      ])
    )

    const fresh = startRpcWorker(s.db, runId)
    await send({ subject: 'Current status', payload: JSON.stringify(fresh) })
    await expect(waiting).resolves.toBe('notified')
    expect(unread()).toEqual([expect.objectContaining({ subject: 'Current status', read: 0 })])
    expect(notify).toHaveBeenCalledOnce()
  })

  it('consumes status from an exact process whose Dispatch was revoked by a settled stop', async () => {
    s.db.beginWorkerStop(worker.dispatchId, 'owned-test-epoch')
    s.db.settleWorkerStop(worker.dispatchId)
    expect(s.db.getDispatchContextById(worker.dispatchId)?.capability_revoked_at).not.toBeNull()
    await send()
    expect(unread()).toEqual([])
  })

  it.each(['start_unknown', 'stop_unknown'] as const)(
    'preserves current status and settlement from %s',
    async (state) => {
      if (state === 'stop_unknown') {
        s.db.beginWorkerStop(worker.dispatchId, 'owned-test-epoch')
        s.db.markWorkerStopUnknown(worker.dispatchId, 'synthetic host contact lost')
      } else {
        s.db.db
          .prepare('UPDATE worker_dispatches SET state = ? WHERE dispatch_id = ?')
          .run(state, worker.dispatchId)
      }
      await send()
      expect(unread()).toHaveLength(1)
      await expect(
        send({ type: 'worker_done', payload: JSON.stringify({ ...worker, outcome: 'succeeded' }) })
      ).resolves.toMatchObject({ lifecycle: { action: 'completed' } })
    }
  )

  it.each([
    ['another process', 'runtime_test:term_worker:2', WORKER_PANE],
    ['another pane', 'runtime_test:term_worker:1', 'tab_other:cccccccc-cccc-4ccc-8ccc-cccccccccccc']
  ])('keeps status from %s visible', async (_name, process, pane) => {
    abandon()
    vi.mocked(s.runtime.getTerminalProcessIncarnation).mockReturnValue(process)
    vi.mocked(s.runtime.getTerminalPaneKey).mockReturnValue(pane)
    await send()
    expect(unread()).toHaveLength(1)
  })

  it.each<[string, Record<string, unknown>]>([
    ['coordinator', { from: 'term_coord' }],
    ['ordinary user', { from: 'user', to: 'RUN' }],
    ['unscoped worker status', { payload: undefined, to: 'RUN' }],
    ['wrong Task', { payload: 'WRONG_TASK' }],
    ['missing Task', { payload: 'MISSING_TASK' }],
    ['malformed ordinary payload', { payload: 'not JSON', to: 'RUN' }]
  ])('preserves %s mail', async (_name, params) => {
    abandon()
    const corrected = {
      ...params,
      ...(params.to === 'RUN' ? { to: `run:${runId}` } : {}),
      ...(params.payload === 'WRONG_TASK'
        ? { payload: JSON.stringify({ ...worker, taskId: 'task_other' }) }
        : {}),
      ...(params.payload === 'MISSING_TASK'
        ? { payload: JSON.stringify({ dispatchId: worker.dispatchId }) }
        : {})
    }
    await send(corrected)
    expect(unread()).toHaveLength(1)
  })

  it('preserves direct status for an unrelated terminal', async () => {
    abandon()
    await send({ to: 'term_teammate' })
    expect(s.db.getUnreadMessages('term_teammate')).toHaveLength(1)
  })

  it('preserves escalation and late settlement rejection for coordinator recovery', async () => {
    abandon()
    await send({ type: 'escalation', subject: 'Recovery evidence' })
    await expect(
      send({
        type: 'worker_done',
        subject: 'Late settlement',
        payload: JSON.stringify({ ...worker, outcome: 'succeeded' })
      })
    ).resolves.toMatchObject({ lifecycle: { action: 'rejected' } })
    expect(unread()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'escalation', subject: 'Recovery evidence' }),
        expect.objectContaining({
          type: 'worker_done',
          payload: expect.stringContaining('_orcaLifecycleRejection')
        })
      ])
    )
  })

  it('refuses scoped status declared from another orchestration party', async () => {
    abandon()
    vi.spyOn(s.runtime, 'getTerminalHandleForPaneKey').mockReturnValue('term_coord')
    await expect(
      h.call(
        'orchestration.send',
        {
          from: 'term_worker',
          type: 'status',
          subject: 'Spoofed worker status',
          payload: JSON.stringify(worker)
        },
        { ...s.ctx, orchestrationCompatibilityEvidence: { paneKey: h.coordinatorPaneKey } }
      )
    ).rejects.toMatchObject({ code: 'consumer_fenced', data: { effectsApplied: false } })
    expect(s.db.getInbox()).toEqual([])
  })

  it('uses equivalent stable panes after a handle remint', async () => {
    abandon()
    vi.mocked(s.runtime.getTerminalPaneKey).mockReturnValue(
      'tab_reminted:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    )
    vi.mocked(s.runtime.getTerminalProcessIncarnation).mockReturnValue('runtime_test:term_worker:1')
    await send({ from: 'term_reminted' })
    expect(unread()).toEqual([])
  })
})
