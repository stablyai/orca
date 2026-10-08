import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../../../core'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationCompatibilityEvidence } from '../../../../../../shared/orchestration-compatibility-evidence'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'

const WORKER_PANE = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const OTHER_WORKER_PANE = 'tab_other:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const NON_PARTY_PANE = 'tab_teammate:dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const WORKER_PROCESS = 'runtime_test:term_worker:1'

describe('worker report authority without a Dispatch capability', () => {
  const harness = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let ctx: RpcContext
  let panes: Record<string, string>

  afterEach(() => harness.cleanup())

  function setup(): void {
    ;({ db, runtime } = harness.setup())
    ctx = { runtime }
    panes = {
      term_coord: harness.coordinatorPaneKey,
      term_worker: WORKER_PANE,
      term_other: OTHER_WORKER_PANE,
      term_teammate: NON_PARTY_PANE
    }
    vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) => panes[handle] ?? null)
    vi.spyOn(runtime, 'getTerminalHandleForPaneKey').mockImplementation(
      (paneKey) => Object.keys(panes).find((handle) => panes[handle] === paneKey) ?? null
    )
    vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
    vi.spyOn(runtime, 'waitForMessage').mockResolvedValue('timed_out')
  }

  function startWorker(name: string, paneKey: string): { taskId: string; dispatchId: string } {
    const task = db.createTask({ spec: `${name} work` })
    const started = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: `term_${name}`,
      paneKey,
      processIncarnation: `runtime_test:term_${name}:1`,
      worktreeId: `repo::${name}`,
      effects: [],
      setupState: 'not_applicable',
      terminalOwnership: 'created'
    })
    db.markWorkerDispatchReady(started.dispatch.id)
    return { taskId: task.id, dispatchId: started.dispatch.id }
  }

  function workerDone(
    worker: { taskId: string; dispatchId: string },
    evidence?: OrchestrationCompatibilityEvidence,
    outcome = 'succeeded'
  ) {
    return harness.call(
      'orchestration.send',
      {
        from: 'term_worker',
        subject: 'Done',
        type: 'worker_done',
        payload: JSON.stringify({ ...worker, outcome })
      },
      { ...ctx, orchestrationCompatibilityEvidence: evidence }
    )
  }

  function ask(evidence?: OrchestrationCompatibilityEvidence) {
    return harness.call(
      'orchestration.ask',
      { from: 'term_worker', question: 'Proceed?', timeoutMs: 1 },
      { ...ctx, orchestrationCompatibilityEvidence: evidence }
    )
  }

  describe('caller fence', () => {
    it.each([
      ['the Run coordinator', harness.coordinatorPaneKey],
      ['another Dispatch worker', OTHER_WORKER_PANE]
    ])('refuses a report sent from %s terminal and records nothing', async (_party, paneKey) => {
      setup()
      startWorker('other', OTHER_WORKER_PANE)
      const worker = startWorker('worker', WORKER_PANE)

      await expect(workerDone(worker, { paneKey })).rejects.toMatchObject({
        code: 'consumer_fenced',
        data: { effectsApplied: false }
      })
      await expect(ask({ paneKey })).rejects.toMatchObject({ code: 'consumer_fenced' })
      expect(
        db.db
          .prepare("SELECT COUNT(*) AS count FROM messages WHERE from_handle = 'term_worker'")
          .get()
      ).toEqual({ count: 0 })
      expect(db.getTask(worker.taskId)?.status).toBe('dispatched')
    })

    it.each<[string, OrchestrationCompatibilityEvidence | undefined]>([
      ['no identity env (old CLI, scrubbed env)', undefined],
      ['its own pane', { paneKey: WORKER_PANE, terminalHandle: 'term_stale_after_remint' }],
      ["another Orca's pane", { paneKey: 'tab_elsewhere:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }],
      ['a stale handle', { terminalHandle: 'term_gone' }],
      ['a live pane that is no orchestration party', { paneKey: NON_PARTY_PANE }]
    ])('accepts a report whose env names %s', async (_case, evidence) => {
      setup()
      const worker = startWorker('worker', WORKER_PANE)

      expect(await workerDone(worker, evidence)).toMatchObject({
        lifecycle: { action: 'completed' }
      })
      expect(db.getTask(worker.taskId)?.status).toBe('completed')
    })

    it('passes the fence for a stale --from handle and leaves refusal to the process check', async () => {
      setup()
      const worker = startWorker('worker', WORKER_PANE)
      panes = { ...panes, term_worker_reminted: WORKER_PANE }
      delete panes.term_worker

      expect(await workerDone(worker, { paneKey: WORKER_PANE })).toMatchObject({
        lifecycle: { action: 'rejected', code: 'worker_identity_changed' }
      })
    })
  })

  describe('worker states', () => {
    it('refuses reports and questions while a stop is in flight', async () => {
      setup()
      const worker = startWorker('worker', WORKER_PANE)
      db.beginWorkerStop(worker.dispatchId, 'epoch_home')

      expect(await workerDone(worker)).toMatchObject({
        lifecycle: { action: 'rejected', code: 'dispatch_inactive' }
      })
      await expect(ask()).rejects.toMatchObject({ code: 'dispatch_inactive' })
      expect(db.getWorkerDispatch(worker.dispatchId)?.state).toBe('stopping')
    })

    it.each([
      ['succeeded', 'completed', 'succeeded'],
      ['failed', 'failed', 'failed']
    ])(
      'settles a %s report after a stop whose outcome is unknown',
      async (outcome, taskStatus, workerState) => {
        setup()
        const worker = startWorker('worker', WORKER_PANE)
        db.beginWorkerStop(worker.dispatchId, 'epoch_home')
        db.markWorkerStopUnknown(worker.dispatchId, 'tab not owned by Orca')

        expect(await workerDone(worker, undefined, outcome)).toMatchObject({
          lifecycle: { action: taskStatus }
        })
        expect(db.getTask(worker.taskId)?.status).toBe(taskStatus)
        expect(db.getWorkerDispatch(worker.dispatchId)).toMatchObject({
          state: workerState,
          ...(outcome === 'succeeded' ? { last_error: null } : {})
        })
      }
    )

    it('refuses a stale process in the worker pane after an unknown stop', async () => {
      setup()
      const worker = startWorker('worker', WORKER_PANE)
      db.beginWorkerStop(worker.dispatchId, 'epoch_home')
      db.markWorkerStopUnknown(worker.dispatchId, 'tab not owned by Orca')
      vi.mocked(runtime.getTerminalProcessIncarnation).mockReturnValue('runtime_test:term_worker:2')

      expect(await workerDone(worker)).toMatchObject({
        lifecycle: { code: 'worker_identity_changed' }
      })
      await expect(ask()).rejects.toMatchObject({ code: 'worker_identity_changed' })
    })
  })

  describe('remote worker states', () => {
    function startRemoteWorker(): string {
      const dispatchId = 'ctx_remote_worker'
      db.createRemoteDispatchAttachment({
        runId: 'run-home',
        dispatchId,
        taskId: 'task_remote_worker',
        homePeerFingerprint: 'run-home-device',
        protocolVersion: 1,
        runtimeEpoch: 'epoch_worker_host',
        mutationReceipt: {
          callerFingerprint: 'run-home-device',
          requestId: 'remote_attach',
          method: 'orchestration.federationAttachStart',
          payloadHash: 'remote_attach_payload'
        }
      })
      db.prepareRemoteAttachmentAuthority({
        dispatchId,
        paneKey: WORKER_PANE,
        processIncarnation: WORKER_PROCESS,
        worktreeId: 'repo::remote',
        terminalHandle: 'term_worker',
        setupState: 'completed',
        effects: []
      })
      return dispatchId
    }

    it.each([
      [
        'stop_unknown',
        (dispatchId: string) => {
          db.markRemoteAttachmentReady(dispatchId)
          db.beginRemoteAttachmentStop(dispatchId)
          db.markRemoteAttachmentStopUnknown(dispatchId, 'tab not owned by Orca')
        }
      ],
      [
        'start_unknown',
        (dispatchId: string) =>
          db.failRemoteAttachment(dispatchId, 'agent_readiness', 'connection lost', true)
      ]
    ])('settles a remote report from %s', async (state, reachState) => {
      setup()
      const dispatchId = startRemoteWorker()
      reachState(dispatchId)
      expect(db.getRemoteDispatchAttachment(dispatchId)?.state).toBe(state)

      expect(await workerDone({ taskId: 'task_remote_worker', dispatchId })).toMatchObject({
        lifecycle: { action: 'completed' }
      })
      expect(db.getRemoteDispatchAttachment(dispatchId)?.state).toBe('succeeded')
    })

    it('refuses a remote report while the stop is in flight', async () => {
      setup()
      const dispatchId = startRemoteWorker()
      db.markRemoteAttachmentReady(dispatchId)
      db.beginRemoteAttachmentStop(dispatchId)

      await expect(workerDone({ taskId: 'task_remote_worker', dispatchId })).rejects.toMatchObject({
        code: 'dispatch_inactive'
      })
      await expect(ask()).rejects.toMatchObject({ code: 'dispatch_inactive' })
      expect(db.listPendingFederationRelay(dispatchId, 'to_home')).toEqual([])
    })
  })
})
