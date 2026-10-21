import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../../../core'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { OrchestrationCompatibilityEvidence } from '../../../../../../shared/orchestration-compatibility-evidence'
import { testOrcaSessionId } from '../../../../../../shared/orca-session-address-test-fixture'
import {
  createRootDispatch,
  reattachDispatchConsumer
} from '../../../../orchestration/db/root-dispatch-test-fixture'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'

const PANE_A = 'tab_a:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const PANE_B = 'tab_b:dddddddd-dddd-4ddd-8ddd-dddddddddddd'

type CheckResult = {
  deliveryId: string | null
  messages: { subject: string }[]
  count: number
  replayed: boolean
}

/** Two processes served one Dispatch mailbox until v36 gave it a consumer generation. */
describe('orchestration.check on a re-attached Dispatch', () => {
  const h = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let ctx: RpcContext

  afterEach(() => {
    h.cleanup()
  })

  function attachedDispatchWithMail(): string {
    ;({ db, runtime, ctx } = h.setup())
    const task = db.createTask({ spec: 'worker that gets replaced' })
    const dispatch = createRootDispatch(db, task.id, 'term_worker', PANE_A)
    reattachDispatchConsumer(db, {
      dispatchId: dispatch.id,
      paneKey: PANE_A,
      processIncarnation: 'runtime:pty-a:1'
    })
    db.insertMessage({
      from: 'term_coord',
      to: `dispatch:${dispatch.id}`,
      subject: 'do the work',
      runId: dispatch.run_id
    })
    return dispatch.id
  }

  function check(paneKey: string, params: Record<string, unknown> = {}) {
    return h.call(
      'orchestration.check',
      { terminal: 'term_worker', terminalPaneKey: paneKey, ...params },
      ctx
    ) as Promise<CheckResult>
  }

  function reattach(dispatchId: string): void {
    reattachDispatchConsumer(db, {
      dispatchId,
      paneKey: PANE_B,
      processIncarnation: 'runtime:pty-b:1'
    })
  }

  /** Same pane, new process: bumps the generation without moving the Dispatch off PANE_A. */
  function remintOnSamePane(dispatchId: string): void {
    reattachDispatchConsumer(db, {
      dispatchId,
      paneKey: PANE_A,
      processIncarnation: 'runtime:pty-a:2'
    })
  }

  it('refuses the stale worker its ack and names the re-attach', async () => {
    const dispatchId = attachedDispatchWithMail()
    const staleDelivery = (await check(PANE_A)).deliveryId
    expect(staleDelivery).not.toBeNull()
    reattach(dispatchId)

    await expect(check(PANE_A, { ack: staleDelivery })).rejects.toMatchObject({
      code: 'consumer_fenced',
      message: expect.stringContaining('no longer owns its Dispatch')
    })
    expect(db.getUnreadMessages(`dispatch:${dispatchId}`)).toHaveLength(1)
  })

  it('hands the live worker a fresh Delivery with the same unread mail', async () => {
    const dispatchId = attachedDispatchWithMail()
    const staleDelivery = (await check(PANE_A)).deliveryId
    reattach(dispatchId)

    const live = await check(PANE_B)
    expect(live.deliveryId).not.toBe(staleDelivery)
    expect(live.replayed).toBe(false)
    expect(live.messages.map((message) => message.subject)).toEqual(['do the work'])

    await check(PANE_B, { ack: live.deliveryId })
    expect(db.getUnreadMessages(`dispatch:${dispatchId}`)).toEqual([])
  })

  it('keeps serving a worker whose process restarted without a re-attach', async () => {
    attachedDispatchWithMail()
    const first = await check(PANE_A)

    const replay = await check(PANE_A)
    expect(replay.deliveryId).toBe(first.deliveryId)
    expect(replay.replayed).toBe(true)
    await expect(check(PANE_A, { ack: first.deliveryId })).resolves.toMatchObject({
      acknowledged: first.deliveryId
    })
  })

  it('refuses the stale worker a plain check, so it cannot steal the next Delivery', async () => {
    const dispatchId = attachedDispatchWithMail()
    await check(PANE_A)
    reattach(dispatchId)

    await expect(check(PANE_A)).rejects.toMatchObject({
      code: 'consumer_fenced',
      message: expect.stringContaining('no longer owns its Dispatch')
    })
    expect(db.getUnreadMessages(`dispatch:${dispatchId}`)).toHaveLength(1)

    const live = await check(PANE_B)
    expect(live.messages.map((message) => message.subject)).toEqual(['do the work'])
    await check(PANE_B, { ack: live.deliveryId })
    expect(db.getUnreadMessages(`dispatch:${dispatchId}`)).toEqual([])
  })

  // Peek is unfenced against a stale generation, but a caller on the wrong pane is not this
  // mailbox's consumer at all, so it must not read the new owner's instructions either.
  it('refuses the stale worker a --peek at the new owner mail', async () => {
    const dispatchId = attachedDispatchWithMail()
    reattach(dispatchId)

    await expect(check(PANE_A, { peek: true })).rejects.toMatchObject({
      code: 'consumer_fenced'
    })
    await expect(check(PANE_A, { all: true })).rejects.toMatchObject({
      code: 'consumer_fenced'
    })
  })

  it('never mints a Delivery at a generation a re-attach already left', async () => {
    const dispatchId = attachedDispatchWithMail()
    const identity = db.getActiveDispatchForIdentity.bind(db)
    let resolved = 0
    vi.spyOn(db, 'getActiveDispatchForIdentity').mockImplementation((handle, paneKey) => {
      resolved += 1
      if (resolved === 2) {
        remintOnSamePane(dispatchId)
      }
      return identity(handle, paneKey)
    })

    await expect(check(PANE_A)).rejects.toMatchObject({ code: 'consumer_fenced' })

    vi.mocked(db.getActiveDispatchForIdentity).mockRestore()
    const live = await check(PANE_A)
    expect(live.messages.map((message) => message.subject)).toEqual(['do the work'])
  })

  it('fences a blocked --peek whose generation moved while it waited', async () => {
    const dispatchId = attachedDispatchWithMail()
    vi.spyOn(runtime, 'waitForMessage').mockImplementation(async () => {
      remintOnSamePane(dispatchId)
      return 'timed_out'
    })

    // Filtered to a type this mailbox has none of, so the peek actually blocks.
    await expect(
      check(PANE_A, { peek: true, wait: true, types: 'escalation' })
    ).rejects.toMatchObject({ code: 'consumer_fenced' })
  })

  it('fences before routing the stale worker direct mail into the new owner mailbox', async () => {
    const dispatchId = attachedDispatchWithMail()
    reattach(dispatchId)
    db.insertMessage({ from: 'term_coord', to: 'term_worker', subject: 'direct to the loser' })

    await expect(check(PANE_A)).rejects.toMatchObject({ code: 'consumer_fenced' })

    expect(db.getUnreadMessages('term_worker').map((message) => message.subject)).toEqual([
      'direct to the loser'
    ])
  })

  it('fences a --peek whose Dispatch was re-attached after the caller resolved it', async () => {
    const dispatchId = attachedDispatchWithMail()
    const identity = db.getActiveDispatchForIdentity.bind(db)
    let resolved = 0
    vi.spyOn(db, 'getActiveDispatchForIdentity').mockImplementation((handle, paneKey) => {
      resolved += 1
      if (resolved === 2) {
        reattach(dispatchId)
      }
      return identity(handle, paneKey)
    })

    await expect(check(PANE_A, { peek: true })).rejects.toMatchObject({
      code: 'consumer_fenced'
    })
  })

  it('serves a worker whose Dispatch row never recorded a pane', async () => {
    ;({ db, runtime, ctx } = h.setup())
    const task = db.createTask({ spec: 'dispatch with no recorded pane' })
    const dispatch = createRootDispatch(db, task.id, 'term_worker')
    db.insertMessage({
      from: 'term_coord',
      to: `dispatch:${dispatch.id}`,
      subject: 'do the work',
      runId: dispatch.run_id
    })

    const result = await check(PANE_A)

    expect(result.messages.map((message) => message.subject)).toEqual(['do the work'])
  })

  it('serves a headless worker whose handle resolves to no pane at all', async () => {
    attachedDispatchWithMail()

    const result = (await h.call(
      'orchestration.check',
      { terminal: 'term_worker' },
      ctx
    )) as CheckResult

    expect(result.messages.map((message) => message.subject)).toEqual(['do the work'])
  })
})

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

const PANE = 'tab_lead:22222222-2222-4222-9222-222222222222'
const OTHER = 'tab_other:33333333-3333-4333-8333-333333333333'
const SESSION = testOrcaSessionId('4bd46b4a-035b-41dd-a122-a9c29122ff11')

describe.each([false, true])('Dispatch recipient identity (settled=%s)', (settled) => {
  const h = createOrchestrationRpcHarness()
  let state: ReturnType<typeof h.setup>
  let dispatch: ReturnType<typeof createRootDispatch>

  beforeEach(() => {
    state = h.setup()
    const task = state.db.createTask({ spec: 'lead' })
    dispatch = createRootDispatch(state.db, task.id, 'term_lead', PANE)
    if (settled) {
      state.db.completeDispatch(dispatch.id)
    }
    vi.spyOn(state.runtime, 'getLiveTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_lead' ? PANE : h.coordinatorPaneKey
    )
  })
  afterEach(() => h.cleanup())

  function send() {
    return h.call(
      'orchestration.send',
      { from: 'term_coord', to: `dispatch:${dispatch.id}`, subject: 'follow up' },
      state.ctx
    )
  }
  function sessionRun() {
    state.db.db
      .prepare('UPDATE dispatch_contexts SET assignee_orca_session_id = ? WHERE id = ?')
      .run(SESSION, dispatch.id)
    return state.db.createRun({
      objective: 'session lead',
      coordinatorHandle: 'term_lead',
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: SESSION
    })
  }
  async function expectRun(runId: string) {
    if (settled) {
      await expect(send()).rejects.toMatchObject({
        code: 'dispatch_inactive',
        message: expect.stringContaining(`Send to run:${runId} instead`)
      })
      expect(state.db.getInbox()).toEqual([])
    } else {
      expect(await send()).toMatchObject({ message: { to_handle: `run:${runId}`, run_id: runId } })
    }
  }
  async function expectNoRedirect(unrelatedRun: string) {
    if (settled) {
      await expect(send()).rejects.toMatchObject({
        code: 'dispatch_inactive',
        message: expect.not.stringContaining(unrelatedRun)
      })
      expect(state.db.getInbox()).toEqual([])
    } else {
      expect(await send()).toMatchObject({
        message: { to_handle: `dispatch:${dispatch.id}`, run_id: dispatch.run_id }
      })
    }
  }

  it('uses a durable session binding without a live pane', async () => {
    const run = sessionRun()
    vi.mocked(state.runtime.getLiveTerminalPaneKey).mockReturnValue(null)
    await expectRun(run.id)
  })

  it('uses the recorded session instead of an unrelated Run now occupying the saved pane', async () => {
    const run = sessionRun()
    state.db.createRun({
      objective: 'new occupant',
      coordinatorHandle: 'term_other',
      coordinatorPaneKey: PANE
    })
    await expectRun(run.id)
  })

  it('ignores an old session column left behind by an older binary rebind', async () => {
    const run = sessionRun()
    state.db.db
      .prepare(
        'UPDATE runs SET coordinator_handle = ?, coordinator_pane_key = ?, consumer_generation = consumer_generation + 1 WHERE id = ?'
      )
      .run('term_other', OTHER, run.id)
    await expectNoRedirect(run.id)
  })

  it('does not follow a closed handle to another occupant of its old pane', async () => {
    const run = state.db.createRun({
      objective: 'new occupant',
      coordinatorHandle: 'term_other',
      coordinatorPaneKey: PANE
    })
    vi.mocked(state.runtime.getLiveTerminalPaneKey).mockReturnValue(null)
    await expectNoRedirect(run.id)
  })

  it.each(['replacement:pty:2', null])(
    'does not redirect with a replaced or unverifiable process: %s',
    async (process) => {
      const run = state.db.createRun({
        objective: 'pane run',
        coordinatorHandle: 'term_lead',
        coordinatorPaneKey: PANE
      })
      state.db.db
        .prepare('UPDATE dispatch_contexts SET process_incarnation = ? WHERE id = ?')
        .run('original:pty:1', dispatch.id)
      vi.mocked(state.runtime.getTerminalProcessIncarnation).mockReturnValue(process)
      await expectNoRedirect(run.id)
      expect(state.db.getDispatchContextById(dispatch.id)?.status).toBe(
        settled ? 'completed' : dispatch.status
      )
    }
  )

  it('accepts a reminted tab half with the same pane leaf and process', async () => {
    const run = state.db.createRun({
      objective: 'same pane',
      coordinatorHandle: 'term_lead',
      coordinatorPaneKey: PANE
    })
    vi.mocked(state.runtime.getLiveTerminalPaneKey).mockReturnValue(
      PANE.replace('tab_lead', 'tab_restored')
    )
    await expectRun(run.id)
  })
})
