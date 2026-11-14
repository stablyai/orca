// After a restart reissues a surviving worker PTY's handle, the worker keeps using its env handle: as a
// finished (kept-open) worker asking its coordinator, and as a worker for another computer's Run.
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

  /** The plain `orchestration check` an Orca wake types: the env handle and pane, nothing else. */
  const check = (from: string = STALE_HANDLE, env: RpcContext = workerEnv()) =>
    harness.call('orchestration.check', { terminal: from, terminalPaneKey: WORKER_PANE }, env)

  const askedId = (asked: unknown): string =>
    asked && typeof asked === 'object' && 'messageId' in asked ? String(asked.messageId) : ''

  const checkedBodies = (checked: unknown): string[] =>
    checked &&
    typeof checked === 'object' &&
    'messages' in checked &&
    Array.isArray(checked.messages)
      ? checked.messages.map((message: { body?: unknown }) => String(message.body))
      : []

  /** The Run home answers the worker's question; the answer lands in its Dispatch mail. */
  const importRemoteAnswer = (questionId: string) =>
    harness.call(
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
              questionId,
              answerMessageId: 'msg_remote_answer',
              body: 'Approved'
            })
          }
        ]
      },
      { ...ctx, authenticatedCallerFingerprint: 'home_peer' }
    )

  const remoteAnswerUnread = () =>
    db.getUnreadMessages(`dispatch:${REMOTE_DISPATCH}`).some((m) => m.body === 'Approved')

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

  describe('working local worker', () => {
    it('consumes its default question answer with the plain check its wake types', async () => {
      setupLocalWorker()
      const asked = await ask({ question: 'Proceed?', wait: false })
      expect(asked).toMatchObject({ pending: true })
      await harness.call(
        'orchestration.reply',
        { id: askedId(asked), body: 'Approved locally', from: 'term_coord' },
        ctx
      )

      expect(checkedBodies(await check())).toContain('Approved locally')
    })
  })

  describe('admission re-read', () => {
    it('refuses a Dispatch record rewritten to another incarnation after entry', () => {
      const { dispatchId } = setupLocalWorker()
      const reporter = resolveWorkerReporterIdentity(runtime, db, {
        from: STALE_HANDLE,
        authority: undefined,
        hasSessionCaller: false,
        evidence: workerEnv().orchestrationCompatibilityEvidence
      })
      expect(reporter.processIncarnation()).toBe(INCARNATION)

      // Record and pane agree on a new process, but it is not the one this request entered as.
      db.db
        .prepare('UPDATE dispatch_contexts SET process_incarnation = ? WHERE id = ?')
        .run(REPLACEMENT, dispatchId)
      paneIncarnation = REPLACEMENT

      expect(reporter.processIncarnation()).toBeNull()
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

    describe('answer to a default (nonblocking) question', () => {
      it('is consumed by the plain check its wake types with the stale env handle', async () => {
        setupFederatedWorker()
        const asked = await ask({ question: 'Proceed?', wait: false })
        expect(asked).toMatchObject({ pending: true })
        await importRemoteAnswer(askedId(asked))
        expect(remoteAnswerUnread()).toBe(true)

        const checked = await check()

        expect(checkedBodies(checked)).toContain('Approved')
        expect(remoteAnswerUnread()).toBe(false)
      })

      it('stays unread when the pane now records a replacement incarnation', async () => {
        setupFederatedWorker()
        const asked = await ask({ question: 'Proceed?', wait: false })
        await importRemoteAnswer(askedId(asked))
        paneIncarnation = REPLACEMENT

        await expect(check()).rejects.toMatchObject({ code: 'dispatch_inactive' })
        expect(remoteAnswerUnread()).toBe(true)
      })

      it('stays unread when a check carries no env evidence for the stale handle', async () => {
        setupFederatedWorker()
        const asked = await ask({ question: 'Proceed?', wait: false })
        await importRemoteAnswer(askedId(asked))

        await expect(check(STALE_HANDLE, ctx)).rejects.toMatchObject({ code: 'dispatch_inactive' })
        expect(remoteAnswerUnread()).toBe(true)
      })

      it('is not handed to the stale handle once another Dispatch owns the pane', async () => {
        setupFederatedWorker()
        const asked = await ask({ question: 'Proceed?', wait: false })
        await importRemoteAnswer(askedId(asked))
        db.settleRemoteAttachmentInRelayTransaction(REMOTE_DISPATCH, 'succeeded')
        const next = db.createTask({ spec: 'next work in the same terminal' })
        const successor = createRootDispatch(
          db,
          next.id,
          REMINTED_HANDLE,
          WORKER_PANE,
          undefined,
          INCARNATION
        )
        db.insertMessage({
          from: 'term_coord',
          to: `dispatch:${successor.id}`,
          subject: 'successor instructions',
          body: 'New local instructions',
          runId: successor.run_id
        })
        const successorUnread = () =>
          db
            .getUnreadMessages(`dispatch:${successor.id}`)
            .some((m) => m.body === 'New local instructions')

        // Neither the old answer nor the successor's instructions, in any check mode.
        await expect(check()).rejects.toMatchObject({ code: 'dispatch_inactive' })
        await expect(
          harness.call(
            'orchestration.check',
            { terminal: STALE_HANDLE, terminalPaneKey: WORKER_PANE, peek: true },
            workerEnv()
          )
        ).rejects.toMatchObject({ code: 'dispatch_inactive' })
        expect(remoteAnswerUnread()).toBe(true)
        expect(successorUnread()).toBe(true)

        // The successor's own current handle still takes its instructions.
        expect(checkedBodies(await check(REMINTED_HANDLE, ctx))).toContain('New local instructions')
        expect(successorUnread()).toBe(false)
      })
    })

    describe('after its remote Dispatch finished and local work began', () => {
      function setupLocalWorkAfterRemoteHistory(handle: string): {
        taskId: string
        dispatchId: string
      } {
        setupFederatedWorker()
        db.settleRemoteAttachmentInRelayTransaction(REMOTE_DISPATCH, 'succeeded')
        const task = db.createTask({ spec: 'local work after the remote Dispatch finished' })
        const dispatch = createRootDispatch(
          db,
          task.id,
          handle,
          WORKER_PANE,
          undefined,
          INCARNATION
        )
        db.db
          .prepare('UPDATE dispatch_contexts SET host_scope = ? WHERE id = ?')
          .run(HOST_SCOPE, dispatch.id)
        return { taskId: task.id, dispatchId: dispatch.id }
      }

      const currentEnv = (): RpcContext => ({
        ...ctx,
        orchestrationCompatibilityEvidence: {
          terminalHandle: REMINTED_HANDLE,
          paneKey: WORKER_PANE,
          launchToken: 'launch-token'
        }
      })

      it.each([
        ['its stale env handle', STALE_HANDLE],
        ['its current handle', REMINTED_HANDLE]
      ])('settles the local Task on a default worker_done from %s', async (_label, handle) => {
        const { taskId, dispatchId } = setupLocalWorkAfterRemoteHistory(handle)

        await expect(
          harness.call(
            'orchestration.send',
            {
              from: handle,
              subject: 'done',
              type: 'worker_done',
              payload: JSON.stringify({ taskId, dispatchId, outcome: 'succeeded' })
            },
            handle === STALE_HANDLE ? workerEnv() : currentEnv()
          )
        ).resolves.toBeDefined()

        expect(db.getTask(taskId)?.status).toBe('completed')
        expect(db.getDispatchContextById(dispatchId)?.status).toBe('completed')
        expect(remoteRelayKinds()).toEqual([])
      })

      it('still refuses mail that names the finished remote Dispatch', async () => {
        setupLocalWorkAfterRemoteHistory(STALE_HANDLE)

        await expect(
          harness.call(
            'orchestration.send',
            {
              from: STALE_HANDLE,
              to: `dispatch:${REMOTE_DISPATCH}`,
              subject: 'late',
              type: 'status'
            },
            workerEnv()
          )
        ).rejects.toMatchObject({ code: 'run_home_unreachable' })
      })
    })

    it('tells a finished worker its default worker_done cannot reach its coordinator', async () => {
      setupFederatedWorker()
      db.settleRemoteAttachmentInRelayTransaction(REMOTE_DISPATCH, 'succeeded')

      await expect(
        send('worker_done', {
          taskId: 'task_remote_restart',
          dispatchId: REMOTE_DISPATCH,
          outcome: 'succeeded'
        })
      ).rejects.toMatchObject({ code: 'run_home_unreachable' })
    })

    it('tells a finished worker its coordinator is unreachable instead of a bare refusal', async () => {
      setupFederatedWorker()
      db.db
        .prepare(`UPDATE remote_dispatch_attachments SET state = 'succeeded' WHERE dispatch_id = ?`)
        .run(REMOTE_DISPATCH)

      await expect(ask()).rejects.toMatchObject({ code: 'run_home_unreachable' })
    })
  })

  describe('stale local check that recovery refuses', () => {
    /** A working local worker whose coordinator has answered its question in its Dispatch mail. */
    async function setupAnsweredLocalWorker(): Promise<{ dispatchId: string }> {
      const { dispatchId } = setupLocalWorker()
      const asked = await ask({ question: 'Proceed?', wait: false })
      await harness.call(
        'orchestration.reply',
        { id: askedId(asked), body: 'Approved locally', from: 'term_coord' },
        ctx
      )
      return { dispatchId }
    }

    const localAnswerUnread = (dispatchId: string) =>
      db.getUnreadMessages(`dispatch:${dispatchId}`).some((m) => m.body === 'Approved locally')

    it.each([
      ['with its env pane', { terminalPaneKey: WORKER_PANE }],
      ['by handle alone', {}]
    ])(
      'leaves the answer unread once the pane records a replacement process (%s)',
      async (_label, paneParams) => {
        const { dispatchId } = await setupAnsweredLocalWorker()
        paneIncarnation = REPLACEMENT

        await expect(
          harness.call(
            'orchestration.check',
            { terminal: STALE_HANDLE, ...paneParams },
            workerEnv()
          )
        ).rejects.toMatchObject({ code: 'dispatch_inactive' })
        expect(localAnswerUnread(dispatchId)).toBe(true)
      }
    )

    it('leaves the answer unread when the check carries no env evidence', async () => {
      const { dispatchId } = await setupAnsweredLocalWorker()

      await expect(check(STALE_HANDLE, ctx)).rejects.toMatchObject({ code: 'dispatch_inactive' })
      expect(localAnswerUnread(dispatchId)).toBe(true)
    })

    it('does not take a reply that arrives after its process was replaced mid-wait', async () => {
      const { dispatchId } = setupLocalWorker()
      const run = db.getDispatchContextById(dispatchId)?.run_id
      vi.spyOn(runtime, 'waitForMessage').mockImplementation(async () => {
        // Same assignment, new process in the pane, then the delayed reply lands.
        paneIncarnation = REPLACEMENT
        db.insertMessage({
          from: 'term_coord',
          to: `dispatch:${dispatchId}`,
          subject: 'late',
          body: 'Delayed reply',
          runId: run
        })
        return new MessageWake()
      })

      await expect(
        harness.call(
          'orchestration.check',
          { terminal: STALE_HANDLE, terminalPaneKey: WORKER_PANE, wait: true },
          workerEnv()
        )
      ).rejects.toMatchObject({ code: 'consumer_fenced' })
      expect(
        db.getUnreadMessages(`dispatch:${dispatchId}`).some((m) => m.body === 'Delayed reply')
      ).toBe(true)
    })

    it('refuses when the process is replaced between recovery and the Dispatch lookup', async () => {
      const { dispatchId } = await setupAnsweredLocalWorker()
      const lookup = db.getActiveDispatchForIdentity.bind(db)
      vi.spyOn(db, 'getActiveDispatchForIdentity').mockImplementation((handle, paneKey) => {
        if (paneKey) {
          paneIncarnation = REPLACEMENT
        }
        return lookup(handle, paneKey)
      })

      await expect(check()).rejects.toMatchObject({ code: 'consumer_fenced' })
      expect(localAnswerUnread(dispatchId)).toBe(true)
    })

    it('takes a reply that arrives mid-wait while it is still the recovered process', async () => {
      const { dispatchId } = setupLocalWorker()
      const run = db.getDispatchContextById(dispatchId)?.run_id
      vi.spyOn(runtime, 'waitForMessage').mockImplementation(async () => {
        db.insertMessage({
          from: 'term_coord',
          to: `dispatch:${dispatchId}`,
          subject: 'late',
          body: 'Delayed reply',
          runId: run
        })
        return new MessageWake()
      })

      const checked = await harness.call(
        'orchestration.check',
        { terminal: STALE_HANDLE, terminalPaneKey: WORKER_PANE, wait: true },
        workerEnv()
      )

      expect(checkedBodies(checked)).toContain('Delayed reply')
    })

    it('still serves the current handle, with or without env evidence', async () => {
      const { dispatchId } = await setupAnsweredLocalWorker()
      paneIncarnation = REPLACEMENT
      await expect(check()).rejects.toMatchObject({ code: 'dispatch_inactive' })

      expect(checkedBodies(await check(REMINTED_HANDLE, ctx))).toContain('Approved locally')
      expect(localAnswerUnread(dispatchId)).toBe(false)
    })

    it('still serves a legacy Dispatch that recorded no process by its pane', async () => {
      setupRuntime()
      const task = db.createTask({ spec: 'legacy worker without a recorded process' })
      const legacy = createRootDispatch(db, task.id, STALE_HANDLE, WORKER_PANE)
      db.insertMessage({
        from: 'term_coord',
        to: `dispatch:${legacy.id}`,
        subject: 'legacy',
        body: 'Legacy instructions',
        runId: legacy.run_id
      })

      expect(checkedBodies(await check(STALE_HANDLE, ctx))).toContain('Legacy instructions')
    })
  })

  describe('finished local question resumed across mixed finished histories', () => {
    /** The handle ran a remote Dispatch, then a local one in the same pane and process; both finished. */
    async function setupMixedFinishedHistory(): Promise<{ taskId: string; dispatchId: string }> {
      setupFederatedWorker()
      db.settleRemoteAttachmentInRelayTransaction(REMOTE_DISPATCH, 'succeeded')
      const task = db.createTask({ spec: 'local work after the remote Dispatch finished' })
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
      await send('worker_done', { taskId: task.id, dispatchId: dispatch.id, outcome: 'succeeded' })
      expect(db.getTask(task.id)?.status).toBe('completed')
      return { taskId: task.id, dispatchId: dispatch.id }
    }

    /** Its own question, asked through the current handle and answered by the coordinator. */
    async function answeredQuestion(): Promise<string> {
      const asked = await harness.call(
        'orchestration.ask',
        { from: REMINTED_HANDLE, question: 'One more thing?', timeoutMs: 1 },
        ctx
      )
      const questionId = askedId(asked)
      await harness.call(
        'orchestration.reply',
        { id: questionId, body: 'Specific local answer', from: 'term_coord' },
        ctx
      )
      return questionId
    }

    const answerRead = (questionId: string) => {
      const answer = db.getQuestion(questionId)?.answer_message_id
      return answer ? db.getMessageById(answer)?.read : undefined
    }

    it('returns the specific answer through the stale handle and leaves the Task completed', async () => {
      const { taskId, dispatchId } = await setupMixedFinishedHistory()
      const questionId = await answeredQuestion()
      expect(db.getQuestion(questionId)?.dispatch_id).toBe(dispatchId)
      expect(answerRead(questionId)).toBe(0)

      const resumed = await ask({ resume: questionId })

      expect(JSON.stringify(resumed)).toContain('Specific local answer')
      expect(answerRead(questionId)).toBe(1)
      expect(db.getTask(taskId)?.status).toBe('completed')
      expect(db.getDispatchContextById(dispatchId)?.status).toBe('completed')
    })

    it('still refuses a bare stale ask: no question selects either history', async () => {
      await setupMixedFinishedHistory()

      await expect(ask()).rejects.toMatchObject({ code: 'dispatch_inactive' })
    })

    it('refuses once the pane records a replacement process', async () => {
      await setupMixedFinishedHistory()
      const questionId = await answeredQuestion()
      paneIncarnation = REPLACEMENT

      await expect(ask({ resume: questionId })).rejects.toMatchObject({
        code: 'dispatch_inactive'
      })
      expect(answerRead(questionId)).toBe(0)
    })

    it('refuses once another Dispatch owns the pane', async () => {
      const { taskId } = await setupMixedFinishedHistory()
      const questionId = await answeredQuestion()
      const next = db.createTask({ spec: 'next work in the same terminal' })
      createRootDispatch(db, next.id, REMINTED_HANDLE, WORKER_PANE, undefined, INCARNATION)

      await expect(ask({ resume: questionId })).rejects.toThrow()
      expect(answerRead(questionId)).toBe(0)
      expect(db.getTask(taskId)?.status).toBe('completed')
    })

    it('does not let another Dispatch question select a recovery for this handle', async () => {
      await setupMixedFinishedHistory()
      // A question owned by another worker's Dispatch is not this handle's recorded history.
      const other = db.createTask({ spec: 'another worker' })
      const otherDispatch = createRootDispatch(
        db,
        other.id,
        'term_other',
        'tab_other:22222222-2222-4222-8222-222222222222',
        undefined,
        'other:inc'
      )
      const { question } = db.createQuestion({
        runId: otherDispatch.run_id,
        dispatchId: otherDispatch.id,
        askerHandle: 'term_other',
        question: 'Not yours',
        options: [],
        to: 'term_coord'
      })

      await expect(ask({ resume: question.message_id })).rejects.toMatchObject({
        code: 'dispatch_inactive'
      })
    })

    it('still resumes through the current handle', async () => {
      const { taskId } = await setupMixedFinishedHistory()
      const questionId = await answeredQuestion()

      const resumed = await harness.call(
        'orchestration.ask',
        { from: REMINTED_HANDLE, resume: questionId, timeoutMs: 1 },
        ctx
      )

      expect(JSON.stringify(resumed)).toContain('Specific local answer')
      expect(db.getTask(taskId)?.status).toBe('completed')
    })
  })
})
