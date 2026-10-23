import './rpc/unused-default-rpc-methods.test-fixture'
// A dispatched chat starting helper workers on the Run it works for, on the coordinator-mail rig:
// the helpers report to it, its own mailbox never moves, and whatever it never handled goes back
// to the Run's coordinator once it settles.

import { describe, expect, it, vi } from 'vitest'
import { formatOrcaSessionAddress } from '../../shared/orca-session-address'
import { testOrcaSessionId } from '../../shared/orca-session-address-test-fixture'
import { idOf, resultOf } from './rpc/orchestration-session-caller-test-fixture'
import type { DispatchCreator } from './orchestration/db/dispatch-depth'
import {
  COORDINATOR,
  PEER_CHAT,
  WAIT,
  WORKER_2_PANE,
  WORKER_PANE,
  call,
  coordinatorRunAndTask,
  db,
  dispatcher,
  openChat,
  request,
  restartRuntime,
  runtime,
  turnText
} from './structured-chat-coordinator-mail-rig.test-fixture'

const WORKER = formatOrcaSessionAddress(testOrcaSessionId(PEER_CHAT))
const HELPER = 'term_worker'
/** A helper's own helper, two levels below the Run's coordinator. */
const LEAF = 'term_worker_2'

async function refusal(method: string, params: Record<string, unknown>, sessionId: string) {
  const response = await dispatcher.dispatch(request(method, params, { sessionId }))
  if (response.ok) {
    throw new Error(`expected a refusal, got ${JSON.stringify(response)}`)
  }
  return response.error
}

/** The helper row worker-start reserves once the worker's authority resolved, in a live terminal. */
function reserveHelper(
  creatorDispatchId: string,
  creator: DispatchCreator = { kind: 'session', orcaSessionId: testOrcaSessionId(PEER_CHAT) },
  handle = HELPER,
  paneKey = WORKER_PANE
): { dispatchId: string; taskId: string } {
  const started = db.createStartingWorkerDispatch({
    creator,
    maxDepth: runtime.getNestedWorkerMaxDepth(),
    requiredCreatorDispatchId: creatorDispatchId,
    taskSpec: 'review the parser',
    taskRunId: db.getDispatchContextById(creatorDispatchId)!.run_id,
    taskParentId: db.getDispatchContextById(creatorDispatchId)!.task_id,
    startOptions: {}
  })
  db.prepareStartingWorkerAuthority({
    dispatchId: started.dispatch.id,
    handle,
    paneKey,
    processIncarnation: `runtime_test:${handle}:1`,
    worktreeId: 'repo::worker',
    effects: [],
    setupState: 'not_applicable'
  })
  db.markWorkerDispatchReady(started.dispatch.id)
  return { dispatchId: started.dispatch.id, taskId: started.task.id }
}

function helperSend(type: string, subject: string, helper: { dispatchId: string; taskId: string }) {
  return call('orchestration.send', {
    from: HELPER,
    type,
    subject,
    payload: JSON.stringify({ ...helper, outcome: 'succeeded' })
  })
}

function inboxOf(inbox: Record<string, unknown>) {
  const messages = Array.isArray(inbox.messages)
    ? inbox.messages.map((message: Record<string, unknown>) => ({
        id: String(message.id),
        subject: String(message.subject),
        type: String(message.type)
      }))
    : []
  return { deliveryId: inbox.deliveryId, messages }
}

/** A chat checks by its session; a terminal helper by its handle. */
async function check(caller: string, ack?: unknown) {
  const byTerminal = caller.startsWith('term_')
  return inboxOf(
    await call(
      'orchestration.check',
      { ...(byTerminal ? { terminal: caller } : {}), ...(ack ? { ack } : {}) },
      byTerminal ? {} : { sessionId: caller }
    )
  )
}

async function subjects(caller: string, ack?: unknown): Promise<string[]> {
  return (await check(caller, ack)).messages.map((message) => message.subject)
}

describe('a worker starting helpers on the Run it works for', () => {
  it('gets their reports and questions in its own check, and hands the unhandled rest to the Run when it settles', async () => {
    await openChat(COORDINATOR)
    await openChat(PEER_CHAT)
    const { runId, taskId } = await coordinatorRunAndTask()
    const parent = idOf(
      (
        await call(
          'orchestration.dispatch',
          { task: taskId, to: WORKER },
          { sessionId: COORDINATOR }
        )
      ).dispatch
    )
    vi.spyOn(runtime, 'getNestedWorkerMaxDepth').mockReturnValue(2)

    // The coordinator seat no longer gates it: the worker reaches the helper-scope rules instead.
    expect(
      await refusal(
        'orchestration.workerStart',
        { run: runId, spec: 'review', terminal: HELPER },
        PEER_CHAT
      )
    ).toMatchObject({ code: 'invalid_argument', message: expect.stringContaining('--terminal') })

    const helper = reserveHelper(parent)
    expect(db.getDispatchContextById(helper.dispatchId)).toMatchObject({
      run_id: runId,
      creator_dispatch_id: parent,
      depth: 2
    })

    await helperSend('escalation', 'Blocked on fixtures', helper)
    const asked = call('orchestration.ask', { from: HELPER, question: 'Which parser?' })
    await vi.waitFor(
      () =>
        expect(db.db.prepare('SELECT COUNT(*) AS n FROM question_threads').get()).toEqual({ n: 1 }),
      WAIT
    )
    const inbox = await check(PEER_CHAT)
    const messages = inbox.messages
    expect(messages.map((message) => message.subject)).toEqual(['Blocked on fixtures', 'Question'])
    await call(
      'orchestration.reply',
      { id: messages.find((message) => message.type === 'question')!.id, body: 'the TOML one' },
      { sessionId: PEER_CHAT }
    )
    expect(await asked).toMatchObject({ answer: 'the TOML one' })

    expect(await subjects(COORDINATOR)).toEqual([])
    expect(await call('orchestration.runCurrent', {}, { sessionId: PEER_CHAT })).toEqual({
      run: null
    })

    // The worker's last check acknowledges what it read; what arrives after goes to the Run.
    expect(await subjects(PEER_CHAT, inbox.deliveryId)).toEqual([])
    await helperSend('escalation', 'Blocked again', helper)
    await call(
      'orchestration.send',
      {
        type: 'worker_done',
        subject: 'Parent done',
        payload: JSON.stringify({ taskId, dispatchId: parent, outcome: 'succeeded' })
      },
      { sessionId: PEER_CHAT }
    )
    await helperSend('worker_done', 'Helper done', helper)
    expect(await subjects(COORDINATOR)).toEqual(['Blocked again', 'Parent done', 'Helper done'])
  })
})

/** The Run's coordinator, a dispatched chat, its terminal helper, and that helper's own helper. */
async function threeLevels() {
  const chat = await openChat(COORDINATOR)
  await openChat(PEER_CHAT)
  const { runId, taskId } = await coordinatorRunAndTask()
  const parent = idOf(
    (await call('orchestration.dispatch', { task: taskId, to: WORKER }, { sessionId: COORDINATOR }))
      .dispatch
  )
  vi.spyOn(runtime, 'getNestedWorkerMaxDepth').mockReturnValue(3)
  const middle = reserveHelper(parent)
  const leaf = reserveHelper(
    middle.dispatchId,
    { kind: 'terminal', handle: HELPER, paneKey: WORKER_PANE },
    LEAF,
    WORKER_2_PANE
  )
  return { chat, runId, middle, leaf }
}

/** The coordinator waiting on questions only, as its loop does between steps. */
async function parkRunQuestionCheck(runId: string) {
  expect(await subjects(COORDINATOR)).toEqual([])
  const parked = call(
    'orchestration.check',
    { wait: true, types: 'question', timeoutMs: 10_000 },
    { sessionId: COORDINATOR }
  )
  await vi.waitFor(
    () => expect(runtime.messageWaitersByHandle.has(`run:${runId}`)).toBe(true),
    WAIT
  )
  return { parked }
}

async function answerFromRun(parked: Promise<Record<string, unknown>>, expected: string[]) {
  const woke = inboxOf(await parked)
  expect(woke.messages.map((message) => message.subject)).toEqual(expected)
  const question = woke.messages.find((message) => message.type === 'question')!
  await call(
    'orchestration.reply',
    { id: question.id, body: 'the TOML one' },
    { sessionId: COORDINATOR }
  )
  return woke
}

describe('a helper whose creator settles between it and the Run', () => {
  it('wakes the Run for its question, which the Run answers, and reports arrive once', async () => {
    const { runId, middle } = await threeLevels()
    await call('orchestration.send', { from: LEAF, type: 'status', subject: 'Read status' })
    const asked = call('orchestration.ask', { from: LEAF, question: 'Which parser?' })
    await vi.waitFor(
      () => expect(db.getAllMessages(`dispatch:${middle.dispatchId}`)).toHaveLength(2),
      WAIT
    )
    // The middle worker reads both, but never answers.
    const read = await check(HELPER)
    expect(read.messages.map((message) => message.subject)).toEqual(['Read status', 'Question'])
    expect(await subjects(HELPER, read.deliveryId)).toEqual([])
    await call('orchestration.send', { from: LEAF, type: 'status', subject: 'Unread status' })
    const { parked } = await parkRunQuestionCheck(runId)

    await helperSend('worker_done', 'Middle done', middle)
    const woke = await answerFromRun(parked, ['Question', 'Unread status'])
    expect(await asked).toMatchObject({ answer: 'the TOML one' })
    expect(await subjects(COORDINATOR, woke.deliveryId)).toEqual([])
    expect(await subjects(PEER_CHAT)).toEqual(['Middle done'])
  })

  it('also hands over a question asked while its creator was being stopped', async () => {
    const { runId, middle } = await threeLevels()
    const { parked } = await parkRunQuestionCheck(runId)
    db.beginWorkerStop(middle.dispatchId, 'test-stop')
    const asked = call('orchestration.ask', { from: LEAF, question: 'Which parser?' })
    await vi.waitFor(
      () => expect(db.getAllMessages(`dispatch:${middle.dispatchId}`)).toHaveLength(1),
      WAIT
    )

    db.settleWorkerStop(middle.dispatchId)
    await answerFromRun(parked, ['Question'])
    expect(await asked).toMatchObject({ answer: 'the TOML one' })
  })

  it('re-offers the handed-back question to the Run on every replay of its settling report', async () => {
    const { runId, middle, leaf } = await threeLevels()
    db.createQuestion({
      runId,
      dispatchId: leaf.dispatchId,
      askerHandle: LEAF,
      question: 'Which parser?',
      to: `dispatch:${middle.dispatchId}`
    })
    const done = request('orchestration.send', {
      from: HELPER,
      type: 'worker_done',
      subject: 'Middle done',
      payload: JSON.stringify({ ...middle, outcome: 'succeeded' })
    })
    resultOf(await dispatcher.dispatch(done))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const countMessages = () => db.db.prepare('SELECT COUNT(*) AS n FROM messages').get()
    const before = countMessages()
    const notify = vi.spyOn(runtime, 'notifyMessageArrived')

    // The second replay reads the receipt the first replay rewrote.
    for (const replays of [1, 2]) {
      expect(resultOf(await dispatcher.dispatch(done))).toMatchObject({
        mutation: { replayed: true }
      })
      expect(
        notify.mock.calls.filter(([to, type]) => to === `run:${runId}` && type === 'question')
      ).toHaveLength(replays)
    }
    expect(countMessages()).toEqual(before)
  })

  it('moves nothing on rollback; a restart offers a committed hand-back nothing woke', async () => {
    const { chat, runId, middle, leaf } = await threeLevels()
    const mailbox = `dispatch:${middle.dispatchId}`
    db.createQuestion({
      runId,
      dispatchId: leaf.dispatchId,
      askerHandle: LEAF,
      question: 'Which parser?',
      to: mailbox
    })
    await call('orchestration.send', { from: LEAF, type: 'status', subject: 'Unread status' })
    const ids = db.getAllMessages(mailbox).map((message) => message.id)
    // The middle worker's pointer for both already landed.
    db.markAsDelivered(ids, mailbox)
    const notify = vi.spyOn(runtime, 'notifyMessageArrived')

    db.db.exec('BEGIN IMMEDIATE')
    db.completeDispatch(middle.dispatchId)
    db.db.exec('ROLLBACK')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(db.getAllMessages(mailbox)).toHaveLength(2)
    expect(db.getUndeliveredUnreadMessages(mailbox)).toEqual([])
    expect(notify).not.toHaveBeenCalledWith(`run:${runId}`, expect.anything())

    // Committed, but the process ends before anything wakes the Run; the old pointer lands late.
    db.mailHandBackListener = undefined
    db.completeDispatch(middle.dispatchId)
    db.markAsDelivered(ids, mailbox)
    expect(db.getUndeliveredUnreadMessages(`run:${runId}`).map((message) => message.id)).toEqual(
      expect.arrayContaining(ids)
    )

    restartRuntime()
    await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)
    expect(turnText(chat.turns[0]!)).toMatch(/orchestration message/)
  })
})
