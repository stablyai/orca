// A restart-recovered worker stays pinned to the exact Dispatch, terminal, host and process it was
// recovered as. These cover the fences after entry: answers taken by a waiting ask, a federated
// Dispatch's mail when the caller loses it, custody across both Dispatch stores, and an ambiguous record.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../../../core'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'
import { resolveWorkerReporterIdentity } from '../../../../orchestration/workers/reports/reminted-worker-reporter'
import { MessageWake } from '../../../../orchestration/mailbox/runtime-message-waiters'

const STALE_HANDLE = 'term_exported-before-restart'
const REMINTED_HANDLE = 'term_reissued-after-restart'
const WORKER_PANE = 'tab_worker:33333333-3333-4333-8333-333333333333'
const OTHER_PANE = 'tab_other:55555555-5555-4555-8555-555555555555'
const PTY_ID = 'wt::/repo/worker@@restored2'
const INCARNATION = `${PTY_ID}:inc-original`
const REPLACEMENT = `${PTY_ID}:inc-replacement`
const HOST_SCOPE = JSON.stringify({ kind: 'local', hostId: 'local' })
const OTHER_HOST_SCOPE = JSON.stringify({ kind: 'ssh', hostId: 'other-host' })
const REMOTE_DISPATCH = 'ctx_remote_fences'

describe('restart-recovered worker fences after entry', () => {
  const harness = createOrchestrationRpcHarness()
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
      handle === 'term_coord'
        ? harness.coordinatorPaneKey
        : handle === REMINTED_HANDLE
          ? WORKER_PANE
          : null
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

  function setupLocalWorker(handle = STALE_HANDLE, paneKey = WORKER_PANE): { dispatchId: string } {
    const task = db.createTask({ spec: 'worker spanning a restart' })
    const dispatch = createRootDispatch(db, task.id, handle, paneKey, undefined, INCARNATION)
    db.db
      .prepare('UPDATE dispatch_contexts SET host_scope = ? WHERE id = ?')
      .run(HOST_SCOPE, dispatch.id)
    return { dispatchId: dispatch.id }
  }

  /** This host runs a worker for another computer's Run; no local Dispatch row exists here. */
  function setupFederatedWorker(handle = STALE_HANDLE, paneKey = WORKER_PANE): void {
    db.createRemoteDispatchAttachment({
      runId: 'run-home',
      dispatchId: REMOTE_DISPATCH,
      taskId: 'task_remote_fences',
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
      paneKey,
      processIncarnation: INCARNATION,
      worktreeId: 'repo::remote-worktree',
      terminalHandle: handle,
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

  const ask = (params: Record<string, unknown>) =>
    harness.call('orchestration.ask', { from: STALE_HANDLE, ...params }, workerEnv())

  /** The question this Dispatch's waiting ask just created. */
  const askedQuestionId = (dispatchId: string): string => {
    const row: unknown = db.db
      .prepare('SELECT message_id FROM question_threads WHERE dispatch_id = ?')
      .get(dispatchId)
    return row && typeof row === 'object' && 'message_id' in row ? String(row.message_id) : ''
  }

  const answerRead = (questionId: string) => {
    const answer = db.getQuestion(questionId)?.answer_message_id
    return answer ? db.getMessageById(answer)?.read : undefined
  }

  describe('a waiting ask', () => {
    it('leaves a local answer unread when the recovered process was replaced mid-wait', async () => {
      setupRuntime()
      const { dispatchId } = setupLocalWorker()
      let questionId = ''
      vi.spyOn(runtime, 'waitForMessage').mockImplementation(async () => {
        questionId = askedQuestionId(dispatchId)
        paneIncarnation = REPLACEMENT
        await harness.call(
          'orchestration.reply',
          { id: questionId, body: 'Late local answer', from: 'term_coord' },
          ctx
        )
        return new MessageWake()
      })

      await expect(ask({ question: 'Proceed?', timeoutMs: 60_000 })).rejects.toMatchObject({
        code: 'consumer_fenced'
      })
      expect(db.getQuestion(questionId)?.dispatch_id).toBe(dispatchId)
      expect(answerRead(questionId)).toBe(0)
    })

    it('still takes the answer while it is the recovered process (control)', async () => {
      setupRuntime()
      const { dispatchId } = setupLocalWorker()
      vi.spyOn(runtime, 'waitForMessage').mockImplementation(async () => {
        const questionId = askedQuestionId(dispatchId)
        await harness.call(
          'orchestration.reply',
          { id: questionId, body: 'Local answer', from: 'term_coord' },
          ctx
        )
        return new MessageWake()
      })

      const asked = await ask({ question: 'Proceed?', timeoutMs: 60_000 })

      expect(asked).toMatchObject({ answer: 'Local answer' })
    })

    it('leaves a federated answer unread when the recovered process was replaced mid-wait', async () => {
      setupRuntime()
      setupFederatedWorker()
      vi.spyOn(runtime, 'waitForMessage').mockImplementation(async () => {
        const [relayed] = db.listFederationRelay({
          dispatchId: REMOTE_DISPATCH,
          direction: 'to_home',
          afterSequence: 0
        })
        paneIncarnation = REPLACEMENT
        await harness.call(
          'orchestration.federationImport',
          {
            dispatchId: REMOTE_DISPATCH,
            items: [
              {
                dispatch_id: REMOTE_DISPATCH,
                direction: 'to_worker',
                sequence: 1,
                message_id: 'relay_answer',
                kind: 'reply',
                payload: JSON.stringify({
                  questionId: relayed?.message_id,
                  answerMessageId: 'msg_remote_answer',
                  body: 'Late remote answer'
                })
              }
            ]
          },
          { ...ctx, authenticatedCallerFingerprint: 'home_peer' }
        )
        return new MessageWake()
      })

      await expect(ask({ question: 'Proceed?', timeoutMs: 60_000 })).rejects.toMatchObject({
        code: 'consumer_fenced'
      })
      expect(
        db
          .getUnreadMessages(`dispatch:${REMOTE_DISPATCH}`)
          .some((m) => m.body === 'Late remote answer')
      ).toBe(true)
    })
  })

  it('keeps a live federated Dispatch mail in its mailbox when the caller loses it mid-wait', async () => {
    setupRuntime()
    setupFederatedWorker()
    vi.spyOn(runtime, 'waitForMessage').mockImplementation(async () => {
      db.insertMessage({
        from: 'term_coord',
        to: `dispatch:${REMOTE_DISPATCH}`,
        subject: 'late',
        body: 'Late remote instructions',
        runId: 'run-home'
      })
      paneIncarnation = REPLACEMENT
      return new MessageWake()
    })

    await expect(
      harness.call(
        'orchestration.check',
        { terminal: STALE_HANDLE, terminalPaneKey: WORKER_PANE, wait: true },
        workerEnv()
      )
    ).rejects.toMatchObject({ code: 'dispatch_inactive' })
    // Still the federated Dispatch's own mail, not moved into this host's placeholder for its Run.
    expect(
      db
        .getUnreadMessages(`dispatch:${REMOTE_DISPATCH}`)
        .some((m) => m.body === 'Late remote instructions')
    ).toBe(true)
    expect(db.getUnreadRunMailbox('run-home', 100).map((m) => m.body)).not.toContain(
      'Late remote instructions'
    )
  })

  it('refuses a finished local record once a later Dispatch from the other store finished there', async () => {
    setupRuntime()
    const { dispatchId } = setupLocalWorker()
    db.db.prepare("UPDATE dispatch_contexts SET status = 'completed' WHERE id = ?").run(dispatchId)
    // The same process then ran a federated Dispatch under its reissued handle, which also finished.
    setupFederatedWorker(REMINTED_HANDLE)
    db.settleRemoteAttachmentInRelayTransaction(REMOTE_DISPATCH, 'succeeded')

    const reporter = resolveWorkerReporterIdentity(runtime, db, {
      from: STALE_HANDLE,
      authority: undefined,
      hasSessionCaller: false,
      evidence: workerEnv().orchestrationCompatibilityEvidence
    })

    expect(reporter.recovered).toBeNull()
    await expect(ask({ question: 'Proceed?', timeoutMs: 1 })).rejects.toBeDefined()
  })

  it('recovers nothing when the handle has two working Dispatches, even named by a question', () => {
    setupRuntime()
    const { dispatchId } = setupLocalWorker()
    // A federated Dispatch still working for the same stale handle, recorded in another pane.
    setupFederatedWorker(STALE_HANDLE, OTHER_PANE)

    const reporter = resolveWorkerReporterIdentity(runtime, db, {
      from: STALE_HANDLE,
      authority: undefined,
      hasSessionCaller: false,
      evidence: workerEnv().orchestrationCompatibilityEvidence,
      candidateDispatchId: dispatchId
    })

    expect(reporter.recovered).toBeNull()
  })

  it('refuses a re-read that finds the recorded process on another host', () => {
    setupRuntime()
    const { dispatchId } = setupLocalWorker()
    const reporter = resolveWorkerReporterIdentity(runtime, db, {
      from: STALE_HANDLE,
      authority: undefined,
      hasSessionCaller: false,
      evidence: workerEnv().orchestrationCompatibilityEvidence
    })
    expect(reporter.processIncarnation()).toBe(INCARNATION)

    // The record now names another host, where a terminal happens to carry the same incarnation.
    db.db
      .prepare('UPDATE dispatch_contexts SET host_scope = ? WHERE id = ?')
      .run(OTHER_HOST_SCOPE, dispatchId)
    vi.spyOn(runtime, 'resolveTerminalHandleByProcessIncarnation').mockImplementation(
      (incarnation) => (incarnation === paneIncarnation ? REMINTED_HANDLE : null)
    )

    expect(reporter.processIncarnation()).toBeNull()
  })
})
