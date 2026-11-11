// After a restart reissues a surviving worker PTY's handle, the worker keeps using its env handle: as a
// finished (kept-open) worker asking its coordinator, and as a worker for another computer's Run.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../../../core'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'

const STALE_HANDLE = 'term_exported-before-restart'
const REMINTED_HANDLE = 'term_reissued-after-restart'
const WORKER_PANE = 'tab_worker:11111111-1111-4111-8111-111111111111'
const PTY_ID = 'wt::/repo/worker@@restored1'
const INCARNATION = `${PTY_ID}:inc-original`
const REPLACEMENT = `${PTY_ID}:inc-replacement`
const HOST_SCOPE = JSON.stringify({ kind: 'local', hostId: 'local' })
const REMOTE_DISPATCH = 'ctx_remote_restart'

describe('restart-reissued worker handle across finished and federated Dispatches', () => {
  const harness = createOrchestrationRpcHarness()
  const { coordinatorPaneKey } = harness
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let ctx: RpcContext
  // What the runtime records for the worker pane; a test swaps it to model a replacement process.
  let paneIncarnation = INCARNATION

  afterEach(() => {
    harness.cleanup()
    paneIncarnation = INCARNATION
  })

  function setupRuntime(): void {
    ;({ db, runtime, ctx } = harness.setup())
    vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_coord' ? coordinatorPaneKey : handle === REMINTED_HANDLE ? WORKER_PANE : null
    )
    vi.mocked(runtime.getTerminalProcessIncarnation).mockImplementation((handle) =>
      handle === REMINTED_HANDLE ? paneIncarnation : null
    )
    vi.spyOn(runtime, 'getTerminalHandleForPaneKey').mockImplementation((paneKey) =>
      paneKey === WORKER_PANE ? REMINTED_HANDLE : null
    )
    vi.spyOn(runtime, 'resolveTerminalHandleByProcessIncarnation').mockImplementation(
      (incarnation, hostScope) =>
        incarnation === paneIncarnation && hostScope === HOST_SCOPE ? REMINTED_HANDLE : null
    )
    vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
    vi.spyOn(runtime, 'waitForMessage').mockResolvedValue('timed_out')
  }

  function setupLocalWorker(): { taskId: string; dispatchId: string } {
    setupRuntime()
    const task = db.createTask({ spec: 'kept-open worker spanning a restart' })
    const dispatch = createRootDispatch(
      db,
      task.id,
      STALE_HANDLE,
      WORKER_PANE,
      undefined,
      INCARNATION
    )
    db.db
      .prepare('UPDATE dispatch_contexts SET host_scope = ? WHERE id = ?')
      .run(HOST_SCOPE, dispatch.id)
    return { taskId: task.id, dispatchId: dispatch.id }
  }

  /** This host runs the worker for another computer's Run; no local Dispatch row exists here. */
  function setupFederatedWorker(): void {
    setupRuntime()
    db.createRemoteDispatchAttachment({
      runId: 'run-home',
      dispatchId: REMOTE_DISPATCH,
      taskId: 'task_remote_restart',
      homePeerFingerprint: 'home_peer',
      protocolVersion: 1,
      runtimeEpoch: runtime.getRuntimeId(),
      mutationReceipt: {
        callerFingerprint: 'home_peer',
        requestId: 'attach_request',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'attach_payload'
      }
    })
    db.prepareRemoteAttachmentAuthority({
      dispatchId: REMOTE_DISPATCH,
      paneKey: WORKER_PANE,
      processIncarnation: INCARNATION,
      worktreeId: 'repo::remote-worktree',
      terminalHandle: STALE_HANDLE,
      setupState: 'not_applicable',
      effects: [],
      hostScope: HOST_SCOPE,
      terminalOwnership: 'created'
    })
    db.markRemoteAttachmentReady(REMOTE_DISPATCH)
  }

  const workerEnv = (): RpcContext => ({
    ...ctx,
    orchestrationCompatibilityEvidence: {
      terminalHandle: STALE_HANDLE,
      paneKey: WORKER_PANE,
      launchToken: 'launch-token'
    }
  })

  const ask = (params: Record<string, unknown> = { question: 'Proceed?' }) =>
    harness.call('orchestration.ask', { from: STALE_HANDLE, timeoutMs: 1, ...params }, workerEnv())

  const send = (type: string, payload: Record<string, unknown>) =>
    harness.call(
      'orchestration.send',
      { from: STALE_HANDLE, subject: type, type, payload: JSON.stringify(payload) },
      workerEnv()
    )

  const remoteRelayKinds = () =>
    db
      .listFederationRelay({ dispatchId: REMOTE_DISPATCH, direction: 'to_home', afterSequence: 0 })
      .map((item) => item.kind)

  describe('finished worker', () => {
    it('asks its coordinator after a stale-handle worker_done and leaves the Task completed', async () => {
      const { taskId, dispatchId } = setupLocalWorker()
      await send('worker_done', { taskId, dispatchId, outcome: 'succeeded' })
      expect(db.getTask(taskId)?.status).toBe('completed')

      const asked = await ask()
      expect(asked).toMatchObject({ messageId: expect.stringMatching(/^msg_/), timedOut: true })
      const messageId =
        asked && typeof asked === 'object' && 'messageId' in asked ? String(asked.messageId) : ''
      const resumed = await ask({ resume: messageId })

      expect(resumed).toMatchObject({ timedOut: true })
      expect(db.getQuestion(messageId)?.dispatch_id).toBe(dispatchId)
      expect(db.getDispatchContextById(dispatchId)?.status).toBe('completed')
      expect(db.getTask(taskId)?.status).toBe('completed')
    })

    it('refuses the question when the pane now records a replacement incarnation', async () => {
      const { taskId, dispatchId } = setupLocalWorker()
      await send('worker_done', { taskId, dispatchId, outcome: 'succeeded' })
      paneIncarnation = REPLACEMENT

      await expect(ask()).rejects.toMatchObject({ code: 'dispatch_inactive' })
    })

    it('refuses the question once another Dispatch owns the pane', async () => {
      const { taskId, dispatchId } = setupLocalWorker()
      await send('worker_done', { taskId, dispatchId, outcome: 'succeeded' })
      const next = db.createTask({ spec: 'next work in the same terminal' })
      createRootDispatch(db, next.id, REMINTED_HANDLE, WORKER_PANE, undefined, INCARNATION)

      await expect(ask()).rejects.toMatchObject({ code: 'consumer_fenced' })
      expect(db.getTask(taskId)?.status).toBe('completed')
    })
  })

  describe('worker for another computer', () => {
    it('relays an escalation and a question to the Run home through its stale handle', async () => {
      setupFederatedWorker()

      await expect(
        send('escalation', { taskId: 'task_remote_restart', dispatchId: REMOTE_DISPATCH })
      ).resolves.toBeDefined()
      await expect(ask()).resolves.toMatchObject({ timedOut: true })

      expect(remoteRelayKinds()).toEqual(['escalation', 'question'])
    })

    it('refuses when the pane now records a replacement incarnation', async () => {
      setupFederatedWorker()
      paneIncarnation = REPLACEMENT

      await expect(ask()).rejects.toMatchObject({ code: 'consumer_fenced' })
      expect(remoteRelayKinds()).toEqual([])
    })

    it('tells a finished worker its coordinator is unreachable instead of a bare refusal', async () => {
      setupFederatedWorker()
      db.db
        .prepare(`UPDATE remote_dispatch_attachments SET state = 'succeeded' WHERE dispatch_id = ?`)
        .run(REMOTE_DISPATCH)

      await expect(ask()).rejects.toMatchObject({ code: 'run_home_unreachable' })
    })
  })
})
