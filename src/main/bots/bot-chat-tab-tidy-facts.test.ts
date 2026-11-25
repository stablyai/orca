import { afterEach, describe, expect, it } from 'vitest'
import { markBotRequestChat } from '../runtime/orchestration/db/bot-requests/bot-request-chats-store'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { isBotRequestChat, readBotChatTabFacts } from './bot-chat-tab-tidy-facts'

const ROOT = '11111111-1111-4111-8111-111111111111'
const MIDDLE = '22222222-2222-4222-8222-222222222222'
const LIVE = '33333333-3333-4333-8333-333333333333'
const address = (id: string) => `orca_session_id:${id}`

let db: OrchestrationDb | null = null

afterEach(() => {
  db?.close()
  db = null
})

function open(): OrchestrationDb {
  db = new OrchestrationDb(':memory:')
  return db
}

function mail(
  store: OrchestrationDb,
  row: { id: string; to?: string; from?: string; read?: boolean; at?: string; type?: string }
): void {
  store.db
    .prepare(
      `INSERT INTO messages (id, from_handle, to_handle, subject, read, created_at, type)
       VALUES (?, ?, ?, 's', ?, ?, ?)`
    )
    .run(
      row.id,
      row.from ?? 'sender',
      row.to ?? 'elsewhere',
      row.read === false ? 0 : 1,
      row.at ?? '2026-11-19 10:01:00',
      row.type ?? 'question'
    )
}

function request(
  store: OrchestrationDb,
  messageId: string,
  extra: { purpose?: string; takenBy?: string; awaiting?: number } = {}
): void {
  store.db
    .prepare(
      `INSERT INTO bot_requests (message_id, root_key, to_bot_id, purpose, depth, record, taken_by, awaiting)
       VALUES (?, ?, 'bot-1', ?, 0, '{}', ?, ?)`
    )
    .run(
      messageId,
      messageId,
      extra.purpose ?? 'question',
      extra.takenBy ?? null,
      extra.awaiting ?? null
    )
}

const facts = (store: OrchestrationDb) =>
  readBotChatTabFacts(store, { rootChatId: ROOT, lineage: [ROOT, MIDDLE, LIVE] })

describe('isBotRequestChat', () => {
  it('is true only for a chat a request opened (its mark), whatever mail it got', () => {
    const store = open()
    mail(store, { id: 'first', to: address(ROOT) })
    request(store, 'first')
    expect(isBotRequestChat(store, ROOT)).toBe(false)
    markBotRequestChat(store, ROOT)
    expect(isBotRequestChat(store, ROOT)).toBe(true)
    expect(isBotRequestChat(store, 'not-a-session')).toBe(false)
  })
})

describe('readBotChatTabFacts', () => {
  it('holds nothing for the request that opened it, read, told and without an outcome', () => {
    const store = open()
    mail(store, { id: 'opening', to: address(ROOT) })
    request(store, 'opening', { takenBy: `session:${ROOT}` })
    expect(facts(store).holds).toEqual([])
  })

  it('holds a question it took and still owes, read or not', () => {
    const store = open()
    mail(store, { id: 'owed', to: address(LIVE) })
    request(store, 'owed', { takenBy: `session:${ROOT}`, awaiting: 1 })
    expect(facts(store).holds).toEqual(['owed-question'])
  })

  it('holds unread mail on an untabbed middle session of its lineage', () => {
    const store = open()
    mail(store, { id: 'unread', to: address(MIDDLE), read: false })
    expect(facts(store).holds).toEqual(['unread-mail'])
  })

  it('holds its own unanswered ask until it has an outcome', () => {
    const store = open()
    mail(store, { id: 'asked', from: address(MIDDLE) })
    request(store, 'asked', { purpose: 'handoff' })
    expect(facts(store).holds).toEqual(['own-request'])
    store.db
      .prepare(
        `INSERT INTO bot_request_outcomes (message_id, outcome) VALUES ('asked', 'answered')`
      )
      .run()
    expect(facts(store).holds).toEqual([])
  })

  it('reads the newest non-heartbeat mail to or from any session of it', () => {
    const store = open()
    mail(store, { id: 'old', to: address(ROOT), at: '2026-11-19 10:00:00' })
    mail(store, { id: 'newer', from: address(MIDDLE), at: '2026-11-20 08:00:00' })
    mail(store, { id: 'beat', to: address(LIVE), at: '2026-11-21 08:00:00', type: 'heartbeat' })
    expect(facts(store).lastMailAt).toBe(Date.parse('2026-11-20T08:00:00Z'))
  })

  it('reads each lookup through an index, never a table scan', () => {
    const store = open()
    const plan = (sql: string, ...values: string[]) =>
      store.db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...values)
        .map((row: unknown) =>
          row && typeof row === 'object' && 'detail' in row ? String(row.detail) : ''
        )
        .join(' | ')
    const lookups = [
      plan(`SELECT 1 FROM messages WHERE to_handle = ? AND read = 0`, 'a'),
      plan(`SELECT 1 FROM bot_requests WHERE taken_by = ? AND awaiting = 1`, 'a'),
      plan(`SELECT 1 FROM question_threads WHERE taken_by = ? AND awaiting = 1`, 'a'),
      plan(
        `SELECT MAX(julianday(created_at)) AS at FROM messages WHERE to_handle = ? AND type <> 'heartbeat'`,
        'a'
      ),
      plan(
        `SELECT MAX(julianday(created_at)) AS at FROM messages WHERE from_handle = ? AND type <> 'heartbeat'`,
        'a'
      ),
      plan(
        `SELECT 1 FROM dispatch_contexts WHERE creator_orca_session_id = ? AND status IN ('pending', 'dispatched')`,
        'a'
      )
    ]
    for (const lookup of lookups) {
      expect(lookup).not.toMatch(
        /\bSCAN (messages|bot_requests|question_threads|dispatch_contexts)\b/
      )
    }
  })
})

describe('readBotChatTabFacts, Run and paired work', () => {
  function withRun(coordinatorGeneration: number): OrchestrationDb {
    const store = open()
    store.db.pragma('foreign_keys = OFF')
    store.db
      .prepare(
        `INSERT INTO runs (id, objective, consumer_generation, coordinator_orca_session_id,
           coordinator_orca_session_id_generation) VALUES ('run-1', 'o', 2, ?, ?)`
      )
      .run(MIDDLE, coordinatorGeneration)
    return store
  }

  it('holds a chat whose Run (it coordinates now) has a pending question, even with its workers done', () => {
    const store = withRun(2)
    store.db
      .prepare(
        `INSERT INTO question_threads (message_id, run_id, dispatch_id, asker_handle)
         VALUES ('q1', 'run-1', 'd1', 'worker')`
      )
      .run()
    expect(facts(store).holds).toEqual(['run-question'])
  })

  it('holds a Run remote question not ended, and unread mail to the Run', () => {
    const remote = withRun(2)
    remote.db
      .prepare(
        `INSERT INTO remote_owned_questions (message_id, conversation_id, run_id, environment_id, dispatch_id)
         VALUES ('r1', 'c1', 'run-1', 'e1', 'd1')`
      )
      .run()
    expect(facts(remote).holds).toEqual(['run-question'])
    const inbox = withRun(2)
    mail(inbox, { id: 'to-run', to: 'run:run-1', read: false })
    expect(facts(inbox).holds).toEqual(['run-question'])
  })

  it('does not count a Run it coordinated at an older generation', () => {
    const store = withRun(1)
    store.db
      .prepare(
        `INSERT INTO question_threads (message_id, run_id, dispatch_id, asker_handle)
         VALUES ('q1', 'run-1', 'd1', 'worker')`
      )
      .run()
    expect(facts(store).holds).toEqual([])
  })

  it('holds a question it asked a paired computer until its answer or notice comes back', () => {
    const store = open()
    store.db
      .prepare(
        `INSERT INTO peer_questions_out (message_id, conversation_id, environment_id, peer_fingerprint, asker, awaiting)
         VALUES ('p1', 'c1', 'e1', 'f1', ?, 1)`
      )
      .run(address(LIVE))
    expect(facts(store).holds).toEqual(['peer-question'])
    store.db.prepare(`UPDATE peer_questions_out SET awaiting = NULL`).run()
    expect(facts(store).holds).toEqual([])
  })
})
