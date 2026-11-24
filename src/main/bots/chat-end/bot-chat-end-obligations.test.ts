// What a side chat owes from orchestration: a Run it coordinated never ends in PR 1; a Dispatch holds
// it only while that Dispatch is open, so a finished one leaves an otherwise idle chat endable.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../runtime/orchestration/db/orchestration-db'
import {
  formatOrcaSessionAddress,
  isOrcaSessionId,
  type OrcaSessionId
} from '../../../shared/agent-session/identity/orca-session-address'
import { botChatEndObligations, plainQuestionQueries } from './bot-chat-end-obligations'

const CHAT_ID = '00000000-0000-4000-8000-0000000000c1'
const CHAT: OrcaSessionId = isOrcaSessionId(CHAT_ID)
  ? CHAT_ID
  : expect.fail('not an Orca session id')
const OTHER = '00000000-0000-4000-8000-0000000000c2'
/** The chat's /clear predecessor: the same lineage, another address. */
const EARLIER_ID = '00000000-0000-4000-8000-0000000000c0'
const EARLIER: OrcaSessionId = isOrcaSessionId(EARLIER_ID)
  ? EARLIER_ID
  : expect.fail('not an Orca session id')

let db: OrchestrationDb

/** Read by a plain caller, as the end checks see it. */
const markRead = (ids: string[]) => db.markAsRead(ids, { kind: 'shell' })

/** The payload `orchestration reply` writes on a reply to a plain question. */
const replyTo = (questionId: string) => JSON.stringify({ replyTo: questionId })

function owes(
  activeRuns: { automationId: string; chatSessionId: string | null }[] = [],
  lineage: readonly string[] = [CHAT]
): ReturnType<typeof botChatEndObligations> {
  const automations = [
    {
      id: 'auto-1',
      name: 'Digest',
      bot: { botId: 'bot-1', runsIn: 'new' as const, resultsTo: 'chat' as const }
    }
  ]
  return botChatEndObligations(
    {
      db,
      automations: () => automations,
      activeRunsInto: (ids) => activeRuns.filter((run) => ids.includes(run.chatSessionId ?? '')),
      deliveryPending: () => false
    },
    'bot-1',
    lineage
  )
}

function dispatch(id: string, status: string, columns: Record<string, string>): void {
  const names = Object.keys(columns)
  db.db
    .prepare(
      `INSERT INTO dispatch_contexts (id, task_id, status, ${names.join(', ')})
       VALUES (?, 'task', ?, ${names.map(() => '?').join(', ')})`
    )
    .run(id, status, ...Object.values(columns))
}

beforeEach(() => {
  db = new OrchestrationDb(':memory:')
})

afterEach(() => {
  db.close()
})

describe('orchestration a side chat took part in', () => {
  it.each([
    ['given', { assignee_orca_session_id: CHAT }],
    ['given by handle', { assignee_handle: formatOrcaSessionAddress(CHAT) }],
    ['created', { creator_orca_session_id: CHAT }]
  ])('holds it while a Dispatch it was %s is open, and not once that is final', (_, columns) => {
    dispatch('d-open', 'dispatched', columns)
    expect(owes()).toEqual([{ kind: 'dispatch', count: 1 }])

    db.db.prepare("UPDATE dispatch_contexts SET status = 'completed' WHERE id = 'd-open'").run()
    expect(owes()).toEqual([])
  })

  it('counts each unfinished Dispatch once, pending or dispatched, even one it gave itself', () => {
    dispatch('d-pending', 'pending', { assignee_orca_session_id: CHAT })
    dispatch('d-self', 'dispatched', {
      creator_orca_session_id: CHAT,
      assignee_orca_session_id: CHAT
    })
    dispatch('d-done', 'failed', { assignee_orca_session_id: CHAT })
    expect(owes()).toEqual([{ kind: 'dispatch', count: 2 }])
  })

  it("never counts another chat's Dispatch", () => {
    dispatch('d-other', 'dispatched', { assignee_orca_session_id: OTHER })
    expect(owes()).toEqual([])
  })

  it('refuses a chat that coordinated a Run for good, finished or not', () => {
    db.createRun({
      objective: 'ship',
      coordinatorHandle: null,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: CHAT
    })
    expect(owes()).toEqual([{ kind: 'ran-workers' }])
  })

  it('keeps a finished worker chat while a question it asked, or one asked of it, waits, even once read', () => {
    dispatch('d-mine', 'completed', { assignee_orca_session_id: CHAT })
    dispatch('d-sub', 'completed', { assignee_orca_session_id: OTHER })
    expect(owes()).toEqual([])

    const question = (id: string, from: string, to: string, dispatchId: string) => {
      db.insertMessage({
        id,
        threadId: id,
        from,
        to,
        subject: 'Question',
        body: '?',
        type: 'question'
      })
      markRead([id])
      db.db
        .prepare(
          `INSERT INTO question_threads (message_id, run_id, dispatch_id, asker_handle)
           VALUES (?, 'run', ?, ?)`
        )
        .run(id, dispatchId, from)
    }
    // It asked after reporting (to its Run); a worker of its own asked it (to its Dispatch).
    question('msg-asked-by', 'dispatch:d-mine', 'run:run', 'd-mine')
    question('msg-asked-of', 'dispatch:d-sub', 'dispatch:d-mine', 'd-sub')
    expect(owes()).toEqual([
      { kind: 'requests', count: 1 },
      { kind: 'questions', count: 1 }
    ])

    db.db.prepare("UPDATE question_threads SET status = 'answered'").run()
    expect(owes()).toEqual([])
  })

  it("keeps it while one of the bot's automation runs into it is still going, from the active runs alone", () => {
    expect(owes([{ automationId: 'auto-1', chatSessionId: CHAT }])).toEqual([
      { kind: 'automation-run' }
    ])
    expect(owes([{ automationId: 'auto-1', chatSessionId: OTHER }])).toEqual([])
    expect(owes([{ automationId: 'someone-else', chatSessionId: CHAT }])).toEqual([])
  })

  it('keeps it while a plain question with no bot request waits for the other side, read or sent', () => {
    const me = formatOrcaSessionAddress(CHAT)
    const asked = db.insertMessage({
      from: 'term_peer',
      to: me,
      subject: 'Ready?',
      type: 'question'
    })
    markRead([asked.id])
    const sent = db.insertMessage({
      from: me,
      to: 'term_peer',
      subject: 'Which?',
      type: 'question'
    })
    expect(owes()).toEqual([
      { kind: 'requests', count: 1 },
      { kind: 'questions', count: 1 }
    ])

    // Its own follow-up answers neither; the other side's replies naming each answer both.
    db.insertMessage({
      from: me,
      to: 'term_peer',
      subject: 'Also',
      threadId: sent.id,
      payload: replyTo(sent.id)
    })
    expect(owes()).toHaveLength(2)
    db.insertMessage({
      from: me,
      to: 'term_peer',
      subject: 'Re: Ready?',
      threadId: asked.id,
      payload: replyTo(asked.id)
    })
    db.insertMessage({
      from: 'term_peer',
      to: me,
      subject: 'Re: Which?',
      threadId: sent.id,
      payload: replyTo(sent.id)
    })
    markRead(db.getUndeliveredUnreadMessages(me, undefined, {}).map((m) => m.id))
    expect(owes()).toEqual([])
  })

  it('takes only a later message as the answer, so an earlier reply in the thread answers nothing', () => {
    const me = formatOrcaSessionAddress(CHAT)
    const root = db.insertMessage({ from: me, to: 'term_peer', subject: 'Plan' })
    // The peer replied earlier; then the chat asks in the same thread.
    db.insertMessage({ from: 'term_peer', to: me, subject: 'Re: Plan', threadId: root.id })
    markRead(db.getUndeliveredUnreadMessages(me, undefined, {}).map((m) => m.id))
    const which = db.insertMessage({
      from: me,
      to: 'term_peer',
      subject: 'Which day?',
      type: 'question',
      threadId: root.id
    })
    // The chat replied earlier; then the peer asks in the same thread.
    const asked = db.insertMessage({
      from: 'term_peer',
      to: me,
      subject: 'Ready?',
      type: 'question',
      threadId: root.id
    })
    markRead([asked.id])
    expect(owes()).toEqual([
      { kind: 'requests', count: 1 },
      { kind: 'questions', count: 1 }
    ])

    // Replies in the shared thread name the question they answer, as `orchestration reply` does.
    db.insertMessage({
      from: me,
      to: 'term_peer',
      subject: 'Yes',
      threadId: root.id,
      payload: replyTo(asked.id)
    })
    db.insertMessage({
      from: 'term_peer',
      to: me,
      subject: 'Friday',
      threadId: root.id,
      payload: replyTo(which.id)
    })
    markRead(db.getUndeliveredUnreadMessages(me, undefined, {}).map((m) => m.id))
    expect(owes()).toEqual([])
  })

  it('takes only the reply naming a question in a shared thread as its answer, and a note none', () => {
    const me = formatOrcaSessionAddress(CHAT)
    const root = db.insertMessage({ from: me, to: 'term_peer', subject: 'Plan' })
    const ask = (subject: string) =>
      db.insertMessage({ from: me, to: 'term_peer', subject, type: 'question', threadId: root.id })
    const first = ask('Which day?')
    ask('Which room?')
    // A progress note in the thread names no question.
    const note = db.insertMessage({
      from: 'term_peer',
      to: me,
      subject: 'Working on it',
      threadId: root.id
    })
    markRead([note.id])
    expect(owes()).toEqual([{ kind: 'questions', count: 2 }])

    const reply = db.insertMessage({
      from: 'term_peer',
      to: me,
      subject: 'Friday',
      threadId: root.id,
      payload: replyTo(first.id)
    })
    markRead([reply.id])
    expect(owes()).toEqual([{ kind: 'questions', count: 1 }])
  })

  it("lets the live chat answer its predecessor's question", () => {
    const me = formatOrcaSessionAddress(CHAT)
    const earlier = formatOrcaSessionAddress(EARLIER)
    const asked = db.insertMessage({
      from: 'term_peer',
      to: earlier,
      subject: 'Ready?',
      type: 'question'
    })
    markRead([asked.id])
    expect(owes([], [EARLIER, CHAT])).toEqual([{ kind: 'requests', count: 1 }])

    db.insertMessage({
      from: me,
      to: 'term_peer',
      subject: 'Yes',
      threadId: asked.id,
      payload: replyTo(asked.id)
    })
    expect(owes([], [EARLIER, CHAT])).toEqual([])
  })

  it('takes no unrelated mail from the other side as the answer: a status, a heartbeat', () => {
    const me = formatOrcaSessionAddress(CHAT)
    const sent = db.insertMessage({
      from: me,
      to: 'term_peer',
      subject: 'Which?',
      type: 'question'
    })
    db.insertMessage({ from: 'term_peer', to: me, subject: 'Build is green' })
    db.insertMessage({
      from: 'term_peer',
      to: me,
      subject: 'alive',
      type: 'heartbeat',
      threadId: sent.id
    })
    markRead(db.getUndeliveredUnreadMessages(me, undefined, {}).map((m) => m.id))
    expect(owes()).toEqual([{ kind: 'questions', count: 1 }])
  })

  it('lets one message answer only the question it replies to, and an unrelated one none', () => {
    const me = formatOrcaSessionAddress(CHAT)
    const first = db.insertMessage({
      from: me,
      to: 'term_peer',
      subject: 'Which?',
      type: 'question'
    })
    db.insertMessage({ from: me, to: 'term_peer', subject: 'When?', type: 'question' })
    const unrelated = db.insertMessage({
      from: 'term_peer',
      to: me,
      subject: 'Done with the other task'
    })
    markRead([unrelated.id])
    expect(owes()).toEqual([{ kind: 'questions', count: 2 }])

    const reply = db.insertMessage({
      from: 'term_peer',
      to: me,
      subject: 'Re',
      threadId: first.id,
      payload: replyTo(first.id)
    })
    markRead([reply.id])
    expect(owes()).toEqual([{ kind: 'questions', count: 1 }])
  })

  it('takes a reply naming its id as the answer, for a question asked inside a thread', () => {
    const me = formatOrcaSessionAddress(CHAT)
    const root = db.insertMessage({ from: me, to: 'term_peer', subject: 'Plan' })
    const asked = db.insertMessage({
      from: me,
      to: 'term_peer',
      subject: 'Which day?',
      type: 'question',
      threadId: root.id
    })
    expect(owes()).toEqual([{ kind: 'questions', count: 1 }])
    const reply = db.insertMessage({
      from: 'term_peer',
      to: me,
      subject: 'Friday',
      threadId: root.id,
      payload: replyTo(asked.id)
    })
    markRead([reply.id])
    expect(owes()).toEqual([])
  })

  it('takes no message in the thread to a third party as the answer, either way', () => {
    const me = formatOrcaSessionAddress(CHAT)
    const asked = db.insertMessage({
      from: 'term_peer',
      to: me,
      subject: 'Ready?',
      type: 'question'
    })
    markRead([asked.id])
    const sent = db.insertMessage({
      from: me,
      to: 'term_peer',
      subject: 'Which?',
      type: 'question'
    })
    db.insertMessage({
      from: me,
      to: 'term_third',
      subject: 'FYI',
      threadId: asked.id,
      payload: replyTo(asked.id)
    })
    db.insertMessage({
      from: 'term_peer',
      to: 'term_third',
      subject: 'FYI',
      threadId: sent.id,
      payload: replyTo(sent.id)
    })
    expect(owes()).toEqual([
      { kind: 'requests', count: 1 },
      { kind: 'questions', count: 1 }
    ])
  })

  it("takes the other side's answer to any address of the chat, but only from the one asked", () => {
    const me = formatOrcaSessionAddress(CHAT)
    const earlier = formatOrcaSessionAddress(EARLIER)
    const sent = db.insertMessage({
      from: earlier,
      to: 'term_peer',
      subject: 'Which?',
      type: 'question'
    })
    db.insertMessage({
      from: 'term_other',
      to: me,
      subject: 'Re',
      threadId: sent.id,
      payload: replyTo(sent.id)
    })
    markRead(db.getUndeliveredUnreadMessages(me, undefined, {}).map((m) => m.id))
    expect(owes([], [EARLIER, CHAT])).toEqual([{ kind: 'questions', count: 1 }])

    const reply = db.insertMessage({
      from: 'term_peer',
      to: me,
      subject: 'That one',
      threadId: sent.id,
      payload: replyTo(sent.id)
    })
    markRead([reply.id])
    expect(owes([], [EARLIER, CHAT])).toEqual([])
  })

  it('answers only the question a reply names, even in the thread another question started', () => {
    const me = formatOrcaSessionAddress(CHAT)
    // The chat asks Q, then a follow-up Q2 in Q's thread; the peer replies to Q2 alone.
    const q = db.insertMessage({
      from: me,
      to: 'term_peer',
      subject: 'Which day?',
      type: 'question'
    })
    const q2 = db.insertMessage({
      from: me,
      to: 'term_peer',
      subject: 'Which room?',
      type: 'question',
      threadId: q.id
    })
    const reply = db.insertMessage({
      from: 'term_peer',
      to: me,
      subject: 'Room 4',
      threadId: q.id,
      payload: replyTo(q2.id)
    })
    markRead([reply.id])
    expect(owes()).toEqual([{ kind: 'questions', count: 1 }])
  })

  it('answers only the named question asked of the chat too, leaving the other one owed', () => {
    const me = formatOrcaSessionAddress(CHAT)
    const q1 = db.insertMessage({ from: 'term_peer', to: me, subject: 'Ready?', type: 'question' })
    const q2 = db.insertMessage({
      from: 'term_peer',
      to: me,
      subject: 'Tested?',
      type: 'question',
      threadId: q1.id
    })
    markRead([q1.id, q2.id])
    db.insertMessage({
      from: me,
      to: 'term_peer',
      subject: 'Yes',
      threadId: q1.id,
      payload: replyTo(q1.id)
    })
    expect(owes()).toEqual([{ kind: 'requests', count: 1 }])
  })

  it("takes no note in a question's own thread as its answer without naming it", () => {
    const me = formatOrcaSessionAddress(CHAT)
    const q = db.insertMessage({
      from: me,
      to: 'term_peer',
      subject: 'Which day?',
      type: 'question'
    })
    const note = db.insertMessage({ from: 'term_peer', to: me, subject: 'Looking', threadId: q.id })
    markRead([note.id])
    expect(owes()).toEqual([{ kind: 'questions', count: 1 }])
  })

  it('reads odd payloads as naming no question, and throws on none', () => {
    const me = formatOrcaSessionAddress(CHAT)
    const q = db.insertMessage({
      from: me,
      to: 'term_peer',
      subject: 'Which day?',
      type: 'question'
    })
    for (const payload of [
      'not json {"replyTo"',
      'null',
      '[]',
      '5',
      '{"replyTo": null}',
      '{"replyTo": 5}',
      JSON.stringify({ replyTo: [q.id] }),
      JSON.stringify({ replyTo: { id: q.id } })
    ]) {
      const odd = db.insertMessage({
        from: 'term_peer',
        to: me,
        subject: 'odd',
        threadId: q.id,
        payload
      })
      markRead([odd.id])
    }
    expect(owes()).toEqual([{ kind: 'questions', count: 1 }])
  })

  it('takes no reply older than the question it names as its answer', () => {
    const me = formatOrcaSessionAddress(CHAT)
    const root = db.insertMessage({ from: me, to: 'term_peer', subject: 'Plan' })
    db.insertMessage({
      from: me,
      to: 'term_peer',
      subject: 'Which day?',
      type: 'question',
      threadId: root.id
    })
    // Names a question asked only after it.
    const early = db.insertMessage({
      from: 'term_peer',
      to: me,
      subject: 'Room 4',
      threadId: root.id,
      payload: replyTo('msg_asked_later')
    })
    markRead([early.id])
    db.insertMessage({
      id: 'msg_asked_later',
      from: me,
      to: 'term_peer',
      subject: 'Which room?',
      type: 'question',
      threadId: root.id
    })
    expect(owes()).toEqual([{ kind: 'questions', count: 2 }])
  })

  it('takes no message of a non-reply type as an answer, even naming the question', () => {
    const me = formatOrcaSessionAddress(CHAT)
    const q = db.insertMessage({
      from: me,
      to: 'term_peer',
      subject: 'Which day?',
      type: 'question'
    })
    const done = db.insertMessage({
      from: 'term_peer',
      to: me,
      subject: 'Done',
      type: 'worker_done',
      threadId: q.id,
      payload: replyTo(q.id)
    })
    markRead([done.id])
    expect(owes()).toEqual([{ kind: 'questions', count: 1 }])
  })

  it("takes no reply outside the chat's question threads as its answer, even naming it", () => {
    const me = formatOrcaSessionAddress(CHAT)
    const q = db.insertMessage({
      from: me,
      to: 'term_peer',
      subject: 'Which day?',
      type: 'question'
    })
    const elsewhere = db.insertMessage({
      from: 'term_peer',
      to: me,
      subject: 'Friday',
      payload: replyTo(q.id)
    })
    markRead([elsewhere.id])
    expect(owes()).toEqual([{ kind: 'questions', count: 1 }])
  })

  it('takes no reply from outside the chat as the answer to a question asked of it', () => {
    const me = formatOrcaSessionAddress(CHAT)
    const asked = db.insertMessage({
      from: 'term_peer',
      to: me,
      subject: 'Ready?',
      type: 'question'
    })
    markRead([asked.id])
    db.insertMessage({
      from: 'term_other',
      to: 'term_peer',
      subject: 'Yes',
      threadId: asked.id,
      payload: replyTo(asked.id)
    })
    expect(owes()).toEqual([{ kind: 'requests', count: 1 }])
  })

  it('leaves a question that is a bot request to the request count, not the plain one', () => {
    const me = formatOrcaSessionAddress(CHAT)
    const asked = db.insertMessage({
      from: 'term_peer',
      to: me,
      subject: 'Ready?',
      type: 'question'
    })
    markRead([asked.id])
    db.db
      .prepare(
        `INSERT INTO bot_requests (message_id, root_key, to_bot_id, purpose, depth, record)
         VALUES (?, 'root', 'bot-1', 'question', 0, '{}')`
      )
      .run(asked.id)
    expect(owes()).toEqual([{ kind: 'requests', count: 1 }])
  })

  it('plans each question thread as one seek and matches replies by the id they name', () => {
    for (const { sql, values } of Object.values(
      plainQuestionQueries([formatOrcaSessionAddress(CHAT)])
    )) {
      const plan = db.db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...values)
        .map((row) => String(row.detail))
      // Never a walk of the messages table, the inbox or the outbox: messages are only reached
      // through the thread index, and each reply finds its question by a lookup on q.
      expect(plan.filter((line) => /^SCAN (m|msg)\b/.test(line))).toEqual([])
      const reads = plan.filter((line) => /^SEARCH msg\b/.test(line))
      expect(reads.length).toBeGreaterThan(0)
      expect(reads.every((line) => line.includes('idx_thread'))).toBe(true)
      expect(plan.some((line) => line.startsWith('SEARCH q '))).toBe(true)
    }
  })

  it('reads replies from above the oldest question of a thread, so an early answer still counts', () => {
    const me = formatOrcaSessionAddress(CHAT)
    const root = db.insertMessage({ from: me, to: 'term_peer', subject: 'Plan' })
    const q1 = db.insertMessage({
      from: me,
      to: 'term_peer',
      subject: 'Which day?',
      type: 'question',
      threadId: root.id
    })
    const answer = db.insertMessage({
      from: 'term_peer',
      to: me,
      subject: 'Friday',
      threadId: root.id,
      payload: replyTo(q1.id)
    })
    markRead([answer.id])
    db.insertMessage({
      from: me,
      to: 'term_peer',
      subject: 'Which room?',
      type: 'question',
      threadId: root.id
    })
    expect(owes()).toEqual([{ kind: 'questions', count: 1 }])
  })
})
