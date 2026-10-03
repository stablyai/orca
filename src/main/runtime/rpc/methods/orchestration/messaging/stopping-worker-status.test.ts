import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOrchestrationRpcHarness, type OrchestrationRpcState } from '../rpc-test-harness'
import { startRpcWorker, WORKER_PANE, WORKER_PROCESS } from '../rpc-worker-authority-test-fixture'

describe('worker status while a stop is in flight', () => {
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
    worker = startRpcWorker(s.db, runId, { ready: false })
  })
  afterEach(() => {
    s.runtime.cancelMessageWaiters(`run:${runId}`)
    h.cleanup()
  })

  function stop() {
    s.db.markWorkerDispatchReady(worker.dispatchId)
    s.db.beginWorkerStop(worker.dispatchId, 'owned-test-epoch')
  }
  function send(params: Record<string, unknown> = {}) {
    return h.call(
      'orchestration.send',
      {
        from: 'term_worker',
        to: `run:${runId}`,
        type: 'status',
        subject: 'Stopping worker status',
        payload: JSON.stringify(worker),
        ...params
      },
      s.ctx
    )
  }
  function unread() {
    return s.db.getUnreadMessages(`run:${runId}`)
  }

  it('records stopping status as delivered history without waking an actual Run waiter', async () => {
    stop()
    expect(s.db.getWorkerDispatch(worker.dispatchId)?.state).toBe('stopping')
    expect(s.db.getDispatchContextById(worker.dispatchId)?.status).toBe('dispatched')
    expect(
      s.db.isDispatchProcessCurrent({
        dispatchId: worker.dispatchId,
        paneKey: WORKER_PANE,
        processIncarnation: WORKER_PROCESS
      })
    ).toBe(true)
    const notify = vi.spyOn(s.runtime, 'notifyMessageArrived')
    let awakened = false
    const waiting = s.runtime
      .waitForMessage(`run:${runId}`, { timeoutMs: 5_000, typeFilter: ['status'] })
      .then((result) => {
        awakened = true
        return result
      })

    await send()

    expect.soft(unread()).toEqual([])
    expect.soft(notify).not.toHaveBeenCalled()
    expect.soft(awakened).toBe(false)
    expect.soft(s.db.getInbox()).toEqual([
      expect.objectContaining({
        subject: 'Stopping worker status',
        read: 1,
        delivered_at: expect.any(String)
      })
    ])
    expect(s.db.getWorkerDispatch(worker.dispatchId)?.state).toBe('stopping')
    expect(s.db.getDispatchContextById(worker.dispatchId)?.status).toBe('dispatched')

    await send({ from: 'term_coord', subject: 'Coordinator status', payload: undefined })
    await expect(waiting).resolves.toBe('notified')
    expect(notify).toHaveBeenCalledExactlyOnceWith(`run:${runId}`, 'status')
    expect(unread()).toEqual([expect.objectContaining({ subject: 'Coordinator status', read: 0 })])
  })

  it.each(['ready', 'start_unknown', 'stop_unknown'] as const)(
    'delivers current %s status and wakes the waiter',
    async (state) => {
      if (state === 'start_unknown') {
        s.db.markWorkerStartUnknown(worker.dispatchId, 'prompt', 'synthetic contact lost')
      } else {
        s.db.markWorkerDispatchReady(worker.dispatchId)
        if (state === 'stop_unknown') {
          s.db.beginWorkerStop(worker.dispatchId, 'owned-test-epoch')
          s.db.markWorkerStopUnknown(worker.dispatchId, 'synthetic contact lost')
          expect(s.db.getDispatchContextById(worker.dispatchId)?.capability_revoked_at).toEqual(
            expect.any(String)
          )
        }
      }
      const notify = vi.spyOn(s.runtime, 'notifyMessageArrived')
      const waiting = s.runtime.waitForMessage(`run:${runId}`, {
        timeoutMs: 5_000,
        typeFilter: ['status']
      })
      await send({ subject: `${state} status` })
      await expect(waiting).resolves.toBe('notified')
      expect(notify).toHaveBeenCalledExactlyOnceWith(`run:${runId}`, 'status')
      expect(unread()).toEqual([expect.objectContaining({ subject: `${state} status`, read: 0 })])
      expect(s.db.getWorkerDispatch(worker.dispatchId)?.state).toBe(state)
    }
  )

  it.each([
    ['another process', 'runtime_test:term_worker:2', WORKER_PANE],
    ['another pane', WORKER_PROCESS, 'tab_other:cccccccc-cccc-4ccc-8ccc-cccccccccccc']
  ])('keeps status from %s visible during stopping', async (_name, process, pane) => {
    stop()
    vi.mocked(s.runtime.getTerminalProcessIncarnation).mockReturnValue(process)
    vi.mocked(s.runtime.getTerminalPaneKey).mockReturnValue(pane)
    const notify = vi.spyOn(s.runtime, 'notifyMessageArrived')
    await send()
    expect(unread()).toHaveLength(1)
    expect(notify).toHaveBeenCalledExactlyOnceWith(`run:${runId}`, 'status')
  })

  it.each<[string, Partial<ReturnType<typeof startRpcWorker>>]>([
    ['wrong Task', { taskId: 'task_other' }],
    ['missing Task', { taskId: undefined }],
    ['wrong Dispatch', { dispatchId: 'ctx_absent' }],
    ['missing Dispatch', { dispatchId: undefined }]
  ])('preserves status with %s', async (_name, fields) => {
    stop()
    const notify = vi.spyOn(s.runtime, 'notifyMessageArrived')
    await send({ payload: JSON.stringify({ ...worker, ...fields }) })
    expect(unread()).toHaveLength(1)
    expect(notify).toHaveBeenCalledExactlyOnceWith(`run:${runId}`, 'status')
  })

  it('preserves status naming another stopping Dispatch owned by a different pane', async () => {
    stop()
    const other = startRpcWorker(s.db, runId, {
      handle: 'term_other',
      paneKey: 'tab_other:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    })
    s.db.beginWorkerStop(other.dispatchId, 'owned-test-epoch')
    await send({ payload: JSON.stringify(other) })
    expect(unread()).toHaveLength(1)
  })

  it.each<[string, Record<string, unknown>]>([
    ['coordinator', { from: 'term_coord', payload: undefined }],
    ['ordinary user', { from: 'user', payload: undefined }],
    ['unscoped worker', { payload: undefined }],
    ['ordinary malformed payload', { payload: 'not JSON' }]
  ])('preserves %s mail while a worker is stopping', async (_name, params) => {
    stop()
    const notify = vi.spyOn(s.runtime, 'notifyMessageArrived')
    await send(params)
    expect(unread()).toHaveLength(1)
    expect(notify).toHaveBeenCalledExactlyOnceWith(`run:${runId}`, 'status')
  })

  it('preserves direct status for an unrelated recipient', async () => {
    stop()
    const notify = vi.spyOn(s.runtime, 'notifyMessageArrived')
    await send({ to: 'term_teammate' })
    expect(s.db.getUnreadMessages('term_teammate')).toHaveLength(1)
    expect(unread()).toEqual([])
    expect(notify).toHaveBeenCalledExactlyOnceWith('term_teammate', 'status')
  })

  it('refuses another Run without recording or notifying', async () => {
    stop()
    const otherRun = s.db.createRun({
      objective: 'Other private Run',
      coordinatorHandle: 'term_other_coord',
      coordinatorPaneKey: 'tab_other_coord:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    })
    const notify = vi.spyOn(s.runtime, 'notifyMessageArrived')
    await expect(send({ to: `run:${otherRun.id}` })).rejects.toMatchObject({
      code: 'dispatch_run_mismatch'
    })
    expect(s.db.getInbox()).toEqual([])
    expect(notify).not.toHaveBeenCalled()
  })

  it('preserves the caller fence for another orchestration party during stopping', async () => {
    stop()
    vi.spyOn(s.runtime, 'getTerminalHandleForPaneKey').mockReturnValue('term_coord')
    await expect(
      h.call(
        'orchestration.send',
        {
          from: 'term_worker',
          type: 'status',
          subject: 'Spoofed stopping status',
          payload: JSON.stringify(worker)
        },
        { ...s.ctx, orchestrationCompatibilityEvidence: { paneKey: h.coordinatorPaneKey } }
      )
    ).rejects.toMatchObject({ code: 'consumer_fenced', data: { effectsApplied: false } })
    expect(s.db.getInbox()).toEqual([])
  })

  it('consumes exact stopping status after a stable pane handle remint', async () => {
    stop()
    vi.mocked(s.runtime.getTerminalPaneKey).mockReturnValue(
      'tab_reminted:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    )
    vi.mocked(s.runtime.getTerminalProcessIncarnation).mockReturnValue(WORKER_PROCESS)
    const notify = vi.spyOn(s.runtime, 'notifyMessageArrived')
    await send({ from: 'term_reminted' })
    expect(unread()).toEqual([])
    expect(notify).not.toHaveBeenCalled()
  })
})
