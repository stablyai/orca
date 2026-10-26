import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOrchestrationRpcHarness, type OrchestrationRpcState } from '../rpc-test-harness'
import { startRpcWorker, WORKER_PANE } from '../rpc-worker-authority-test-fixture'

describe('worker parent Run binding', () => {
  const h = createOrchestrationRpcHarness()
  let s: OrchestrationRpcState
  let runId: string
  beforeEach(() => {
    s = h.setup()
    runId = s.activeRunId!
    vi.mocked(s.runtime.getTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_coord' ? h.coordinatorPaneKey : WORKER_PANE
    )
  })
  afterEach(() => h.cleanup())
  function call(method: string, params: Record<string, unknown>) {
    return h.call(`orchestration.${method}`, params, s.ctx)
  }
  function use(from = 'term_worker', id = runId) {
    return call('runUse', { id, from })
  }

  it.each([false, true])(
    'refuses an attached worker with ready=%s before all binding effects',
    async (ready) => {
      const worker = startRpcWorker(s.db, runId, { ready })
      const coordinatorTask = s.db.createTask({ runId, spec: 'Independent coordinator work' })
      const child = s.db.createRun({
        objective: 'Worker child Run',
        coordinatorHandle: 'term_worker',
        coordinatorPaneKey: WORKER_PANE
      })
      s.db.insertMessage({ from: 'term_worker', to: `run:${runId}`, subject: 'Coordinator mail' })
      const delivery = await call('check', { terminal: 'term_coord' })
      if (
        typeof delivery !== 'object' ||
        delivery === null ||
        !('deliveryId' in delivery) ||
        typeof delivery.deliveryId !== 'string'
      ) {
        throw new Error('Expected a coordinator Delivery')
      }
      const before = {
        run: s.db.getRun(runId),
        child: s.db.getRun(child.id),
        dispatch: s.db.getDispatchContextById(worker.dispatchId),
        worker: s.db.getWorkerDispatch(worker.dispatchId),
        resource: s.db.getWorkerTerminalResourceByOwner(worker.dispatchId),
        mail: s.db.getInbox()
      }
      const cancel = vi.spyOn(s.runtime, 'cancelMessageWaiters')

      await expect(use()).rejects.toMatchObject({
        code: 'consumer_fenced',
        data: { effectsApplied: false }
      })

      expect(s.db.getRun(runId)).toEqual(before.run)
      expect(s.db.getRun(child.id)).toEqual(before.child)
      expect(s.db.getDispatchContextById(worker.dispatchId)).toEqual(before.dispatch)
      expect(s.db.getWorkerDispatch(worker.dispatchId)).toEqual(before.worker)
      expect(s.db.getWorkerTerminalResourceByOwner(worker.dispatchId)).toEqual(before.resource)
      expect(s.db.getInbox()).toEqual(before.mail)
      expect(cancel).not.toHaveBeenCalled()
      expect(await call('check', { terminal: 'term_coord' })).toMatchObject({
        deliveryId: delivery.deliveryId,
        replayed: true
      })
      await expect(
        call('check', { terminal: 'term_coord', ack: delivery.deliveryId })
      ).resolves.toMatchObject({ acknowledged: delivery.deliveryId, count: 0 })
      await expect(
        call('taskUpdate', {
          id: coordinatorTask.id,
          status: 'blocked',
          callerTerminalHandle: 'term_coord'
        })
      ).resolves.toMatchObject({ task: { status: 'blocked' } })
    }
  )

  it('preserves the original coordinator binding during legal self-dispatch', async () => {
    startRpcWorker(s.db, runId, { handle: 'term_coord', paneKey: h.coordinatorPaneKey })
    await expect(use('term_coord')).resolves.toMatchObject({
      run: { consumer_generation: 1, coordinator_handle: 'term_coord' }
    })
  })

  it('allows its worker to own and rebind a distinct child Run', async () => {
    startRpcWorker(s.db, runId)
    const child = s.db.createRun({
      objective: 'Nested work',
      coordinatorHandle: null,
      coordinatorPaneKey: null
    })
    await expect(use('term_worker', child.id)).resolves.toMatchObject({
      run: { id: child.id, coordinator_handle: 'term_worker' }
    })
    expect(s.db.getRun(runId)).toMatchObject({
      coordinator_handle: 'term_coord',
      consumer_generation: 1
    })
    await expect(use()).rejects.toMatchObject({ code: 'consumer_fenced' })
    expect(s.db.getCurrentRunForPane(WORKER_PANE)?.id).toBe(child.id)
  })

  it('allows future coordinator ownership after accepted settlement', async () => {
    const worker = startRpcWorker(s.db, runId)
    await expect(
      call('send', {
        from: 'term_worker',
        type: 'worker_done',
        subject: 'Finished',
        payload: JSON.stringify({ ...worker, outcome: 'succeeded' })
      })
    ).resolves.toMatchObject({ lifecycle: { action: 'completed' } })
    await expect(use()).resolves.toMatchObject({
      run: { coordinator_handle: 'term_worker', consumer_generation: 2 }
    })
  })

  it('checks the target Run even when a newer global handle match exists', async () => {
    startRpcWorker(s.db, runId)
    const other = s.db.createRun({
      objective: 'Other work',
      coordinatorHandle: null,
      coordinatorPaneKey: null
    })
    const newer = startRpcWorker(s.db, other.id, {
      handle: 'term_other',
      paneKey: 'tab_other:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    })
    s.db.db
      .prepare('UPDATE dispatch_contexts SET assignee_handle = ? WHERE id = ?')
      .run('term_worker', newer.dispatchId)
    await expect(use()).rejects.toMatchObject({ code: 'consumer_fenced' })
    expect(s.db.getRun(runId)?.consumer_generation).toBe(1)
  })

  it('matches a reminted handle by its stable pane leaf', async () => {
    startRpcWorker(s.db, runId)
    vi.mocked(s.runtime.getTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_coord'
        ? h.coordinatorPaneKey
        : 'tab_reminted:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    )
    await expect(use('term_reminted')).rejects.toMatchObject({ code: 'consumer_fenced' })
  })

  it('refuses a caller that attests another terminal', async () => {
    startRpcWorker(s.db, runId)
    vi.spyOn(s.runtime, 'verifyOrchestrationCompatibilityCaller').mockReturnValue({
      terminalHandle: 'term_worker',
      paneKey: WORKER_PANE,
      processIncarnation: 'runtime_test:term_worker:1',
      hostScope: { kind: 'local', hostId: 'local' },
      launchTokenHash: 'synthetic'
    })
    await expect(
      h.call(
        'orchestration.runUse',
        { id: runId, from: 'term_coord' },
        { ...s.ctx, orchestrationCompatibilityEvidence: { terminalHandle: 'term_worker' } }
      )
    ).rejects.toMatchObject({ code: 'consumer_fenced', data: { effectsApplied: false } })
    expect(s.db.getRun(runId)?.consumer_generation).toBe(1)
  })
})
