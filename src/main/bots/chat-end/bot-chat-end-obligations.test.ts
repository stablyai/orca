// What a side chat owes from orchestration: a Run it coordinated never ends in PR 1; a Dispatch holds
// it only while that Dispatch is open, so a finished one leaves an otherwise idle chat endable.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../runtime/orchestration/db/orchestration-db'
import {
  formatOrcaSessionAddress,
  isOrcaSessionId,
  type OrcaSessionId
} from '../../../shared/agent-session/identity/orca-session-address'
import { botChatEndObligations } from './bot-chat-end-obligations'

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
      db.markAsRead([id])
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
    db.markAsRead([asked.id])
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

    // Its own follow-up answers neither; the other side's replies in each thread answer both.
    db.insertMessage({ from: me, to: 'term_peer', subject: 'Also', threadId: sent.id })
    expect(owes()).toHaveLength(2)
    db.insertMessage({ from: me, to: 'term_peer', subject: 'Re: Ready?', threadId: asked.id })
    db.insertMessage({ from: 'term_peer', to: me, subject: 'Re: Which?', threadId: sent.id })
    db.markAsRead(db.getUndeliveredUnreadMessages(me, undefined, {}).map((m) => m.id))
    expect(owes()).toEqual([])
  })

  it('takes only a later message as the answer, so an earlier reply in the thread answers nothing', () => {
    const me = formatOrcaSessionAddress(CHAT)
    const root = db.insertMessage({ from: me, to: 'term_peer', subject: 'Plan' })
    // The peer replied earlier; then the chat asks in the same thread.
    db.insertMessage({ from: 'term_peer', to: me, subject: 'Re: Plan', threadId: root.id })
    db.markAsRead(db.getUndeliveredUnreadMessages(me, undefined, {}).map((m) => m.id))
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
    db.markAsRead([asked.id])
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
    db.markAsRead(db.getUndeliveredUnreadMessages(me, undefined, {}).map((m) => m.id))
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
    db.markAsRead([note.id])
    expect(owes()).toEqual([{ kind: 'questions', count: 2 }])

    const reply = db.insertMessage({
      from: 'term_peer',
      to: me,
      subject: 'Friday',
      threadId: root.id,
      payload: replyTo(first.id)
    })
    db.markAsRead([reply.id])
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
    db.markAsRead([asked.id])
    expect(owes([], [EARLIER, CHAT])).toEqual([{ kind: 'requests', count: 1 }])

    db.insertMessage({ from: me, to: 'term_peer', subject: 'Yes', threadId: asked.id })
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
    db.markAsRead(db.getUndeliveredUnreadMessages(me, undefined, {}).map((m) => m.id))
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
    db.markAsRead([unrelated.id])
    expect(owes()).toEqual([{ kind: 'questions', count: 2 }])

    const reply = db.insertMessage({ from: 'term_peer', to: me, subject: 'Re', threadId: first.id })
    db.markAsRead([reply.id])
    expect(owes()).toEqual([{ kind: 'questions', count: 1 }])
  })

  it('takes a reply to its id as the answer, for a question asked inside a thread', () => {
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
      threadId: asked.id
    })
    db.markAsRead([reply.id])
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
    db.markAsRead([asked.id])
    const sent = db.insertMessage({
      from: me,
      to: 'term_peer',
      subject: 'Which?',
      type: 'question'
    })
    db.insertMessage({ from: me, to: 'term_third', subject: 'FYI', threadId: asked.id })
    db.insertMessage({ from: 'term_peer', to: 'term_third', subject: 'FYI', threadId: sent.id })
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
    db.insertMessage({ from: 'term_other', to: me, subject: 'Re', threadId: sent.id })
    db.markAsRead(db.getUndeliveredUnreadMessages(me, undefined, {}).map((m) => m.id))
    expect(owes([], [EARLIER, CHAT])).toEqual([{ kind: 'questions', count: 1 }])

    const reply = db.insertMessage({
      from: 'term_peer',
      to: me,
      subject: 'That one',
      threadId: sent.id
    })
    db.markAsRead([reply.id])
    expect(owes([], [EARLIER, CHAT])).toEqual([])
  })
})
