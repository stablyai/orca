import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { startRestingQuestionReconciler } from '../../../../orchestration/mailbox/questions/question-reconciler.test-fixture'
import { dropReaderlessRunQuestions } from '../../../../orchestration/db/questions/readerless-run-questions'
import { waitForQuestionAnswer } from '../../../../orchestration/mailbox/questions/question-answer-delivery'
import { testOrcaSessionId } from '../../../../../../shared/agent-session/identity/orca-session-address-test-fixture'
import { ORCHESTRATION_FEDERATION_CONTROL_MAIL_PROTOCOL_VERSION } from '../../../../../../shared/orchestration/orchestration-runtime-capabilities'
import { workerAskNotices } from './worker-ask-notices'
import { QuestionReconciler } from '../../../../orchestration/mailbox/questions/question-reconciler'

const COORDINATOR = testOrcaSessionId('33333333-3333-4333-8333-333333333333')
const UNANSWERED =
  'Your coordinator stopped without answering your question and has no worker running for it. Decide it yourself and say what you chose when you report. If an answer comes later, it still reaches you.'

describe("a worker's question its coordinator stopped on", () => {
  let db: OrchestrationDb
  let arrived: string[]
  let runtime: Pick<
    OrcaRuntimeService,
    | 'getOrchestrationDb'
    | 'notifyMessageArrived'
    | 'notifyMessageWaiters'
    | 'ensureOrchestrationFederationRelay'
    | 'waitForMessage'
  >

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    arrived = []
    runtime = {
      getOrchestrationDb: () => db,
      notifyMessageArrived: (handle: string) => void arrived.push(handle),
      notifyMessageWaiters: () => false,
      ensureOrchestrationFederationRelay: vi.fn(),
      waitForMessage: async () => 'timed_out' as const
    }
  })
  afterEach(() => db.close())

  function workerIn(coordinated: boolean): { runId: string; dispatchId: string } {
    const run = db.createRun({
      objective: 'o',
      coordinatorHandle: null,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: coordinated ? COORDINATOR : null
    })
    const task = db.createTask({ spec: 'work', runId: run.id })
    const started = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: 10,
      taskId: task.id,
      startOptions: {}
    })
    db.markWorkerDispatchReady(started.dispatch.id)
    return { runId: run.id, dispatchId: started.dispatch.id }
  }

  function ask(worker: { runId: string; dispatchId: string }): string {
    return db.createQuestion({ ...worker, askerHandle: 'term_w', question: 'Which font?' }).message
      .id
  }

  async function decided(reconciler: { settled(): Promise<void> }) {
    for (let i = 0; i < 3; i++) {
      await new Promise((resolve) => setImmediate(resolve))
      await reconciler.settled()
    }
  }

  function start() {
    const questions = startRestingQuestionReconciler(db, async (taker) =>
      workerAskNotices(runtime, taker)
    )
    onTestFinished(questions.stop)
    return questions.reconciler
  }

  it('tells the worker once, on its Dispatch, when the coordinator that read it stopped', async () => {
    const reconciler = start()
    const worker = workerIn(true)
    const id = ask(worker)
    db.markAsRead([id], { kind: 'session', sessionId: COORDINATOR })
    await decided(reconciler)
    reconciler.decideAll()
    await decided(reconciler)

    const mail = db.getAllMessagesForHandle(`dispatch:${worker.dispatchId}`)
    expect(mail.map((m) => [m.thread_id, m.body])).toEqual([[id, UNANSWERED]])
    expect(db.getQuestionRaw(id)?.told).toBe('unanswered')
    expect(db.getQuestionRaw(id)?.status).toBe('pending')
    expect(arrived).toEqual([`dispatch:${worker.dispatchId}`])
  })

  it('tells the worker at once when no one coordinates its Run, and leaves the question to answer', async () => {
    const reconciler = start()
    const worker = workerIn(false)
    const id = ask(worker)
    dropReaderlessRunQuestions(db, worker.runId)
    await decided(reconciler)

    const mail = db.getAllMessagesForHandle(`dispatch:${worker.dispatchId}`)
    expect(mail.map((m) => m.body)).toEqual([
      `No one coordinates Run ${worker.runId} now, so no one will read your question. Decide it yourself and say what you chose when you report.`
    ])
    expect(db.getQuestionRaw(id)?.told).toBe('dropped')
    expect(db.getMessageById(id)?.read).toBe(0)
  })

  it('returns a waiting ask with the notice, which then is not delivered again', async () => {
    const reconciler = start()
    const worker = workerIn(true)
    const id = ask(worker)
    db.markAsRead([id], { kind: 'session', sessionId: COORDINATOR })
    await decided(reconciler)

    const waited = await waitForQuestionAnswer({
      runtime,
      questionId: id,
      readQuestion: () => db.getQuestion(id),
      closedMessage: 'closed',
      timeoutMs: 60_000
    })
    expect(waited).toMatchObject({ answer: null, told: 'unanswered', notice: UNANSWERED })
    const [notice] = db.getAllMessagesForHandle(`dispatch:${worker.dispatchId}`)
    expect(notice?.read).toBe(1)
  })

  it('keeps a resumed wait waiting for a late answer once the notice was seen', async () => {
    const reconciler = start()
    const worker = workerIn(true)
    const id = ask(worker)
    db.markAsRead([id], { kind: 'session', sessionId: COORDINATOR })
    await decided(reconciler)
    const [notice] = db.getAllMessagesForHandle(`dispatch:${worker.dispatchId}`)
    db.markAsRead([notice!.id], { kind: 'orca' })

    const waited = await waitForQuestionAnswer({
      runtime,
      questionId: id,
      readQuestion: () => db.getQuestion(id),
      closedMessage: 'closed',
      timeoutMs: 1
    })
    expect(waited).toMatchObject({ answer: null, timedOut: true })
  })

  it('tells a worker on a paired computer by coordinator mail', async () => {
    const worker = workerIn(true)
    const id = ask(worker)
    vi.spyOn(db, 'getFederatedDispatch').mockReturnValue({
      dispatch_id: worker.dispatchId,
      environment_id: 'env_build_box',
      environment_name: 'Build Box',
      peer_fingerprint: 'fp',
      remote_runtime_epoch: null,
      protocol_version: ORCHESTRATION_FEDERATION_CONTROL_MAIL_PROTOCOL_VERSION,
      remote_worktree_id: null,
      remote_terminal_handle: null,
      to_home_imported_sequence: 0,
      to_home_acknowledged_sequence: 0,
      home_auto_release_at: null,
      home_auto_release_state: null,
      created_at: '2026-11-21 00:00:00',
      updated_at: '2026-11-21 00:00:00'
    })
    const relay = vi.spyOn(db, 'enqueueFederationRelay')
    db.markAsRead([id], { kind: 'session', sessionId: COORDINATOR })
    expect(
      workerAskNotices(
        runtime,
        `session:${COORDINATOR}`
      )({ messageId: id, taker: '', kind: 'worker-ask' })
    ).toBe('told')

    expect(relay).toHaveBeenCalledWith(
      expect.objectContaining({ direction: 'to_worker', kind: 'control_message' })
    )
    expect(JSON.parse(relay.mock.calls[0]![0].payload)).toMatchObject({
      subject: 'Re: Question',
      body: UNANSWERED,
      threadId: id
    })
    expect(db.getAllMessagesForHandle(`dispatch:${worker.dispatchId}`)).toEqual([])
  })

  it("tells a linked worker's own question first, so the question it works on stays held", async () => {
    const receiver = testOrcaSessionId('44444444-4444-4444-8444-444444444444')
    const asked = db.admitBotRequest({
      rootKey: 'linked',
      fromBotId: 'ranger',
      toBotId: 'docs',
      purpose: 'question',
      depth: 1,
      record: '{}',
      message: {
        from: 'orca_session_id:asker',
        to: `orca_session_id:${receiver}`,
        subject: 'q',
        type: 'question'
      }
    })
    const question = asked.kind === 'sent' ? asked.message.id : ''
    db.markAsRead([question], { kind: 'session', sessionId: receiver })
    const run = db.createRun({
      objective: 'o',
      coordinatorHandle: null,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: receiver
    })
    const linked = db.createStartingWorkerDispatch({
      taskSpec: 'find out',
      taskRunId: run.id,
      creator: { kind: 'system' },
      maxDepth: 10,
      startOptions: {},
      forMessageId: question
    })
    db.markWorkerDispatchReady(linked.dispatch.id)
    db.db
      .prepare('UPDATE dispatch_contexts SET assignee_orca_session_id = ? WHERE id = ?')
      .run('worker-chat', linked.dispatch.id)
    const toldBot: string[] = []
    const reconciler = new QuestionReconciler(db, {
      reads: {
        liveSession: (root) => root,
        chatRunning: async () => false,
        chatReceiving: (mailbox) =>
          mailbox === `dispatch:${linked.dispatch.id}` ? 'worker-chat' : receiver,
        chatHandingOver: () => false,
        terminal: () => null,
        terminalHandingOver: () => false
      },
      notices: async (taker) => {
        const worker = workerAskNotices(runtime, taker)
        return (notice) =>
          notice.kind === 'bot' ? (toldBot.push(notice.messageId), 'told') : worker(notice)
      },
      sessionParty: (sessionId) => `session:${sessionId}`,
      terminalParty: () => null
    })
    onTestFinished(reconciler.start())
    // The worker asks the receiver, which reads it and stops without answering either.
    const workerAsk = ask({ runId: run.id, dispatchId: linked.dispatch.id })
    db.markAsRead([workerAsk], { kind: 'session', sessionId: receiver })
    await decided(reconciler)

    expect(db.getQuestionRaw(workerAsk)?.told).toBe('unanswered')
    // Its notice wakes the worker, which still works on the question.
    expect(toldBot).toEqual([])
  })
})
