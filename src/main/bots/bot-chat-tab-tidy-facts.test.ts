import { afterEach, describe, expect, it } from 'vitest'
import { markBotRequestChat } from '../runtime/orchestration/db/bot-requests/bot-request-chats-store'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { readBotChatTabFacts, sqliteUtcMs } from './bot-chat-tab-tidy-facts'

const CHAT = '11111111-1111-4111-8111-111111111111'
const SUCCESSOR = '22222222-2222-4222-8222-222222222222'
const ADDRESS = `orca_session_id:${CHAT}`
const CREATED_AT = sqliteUtcMs('2026-11-19 10:00:00')!

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

function request(store: OrchestrationDb, messageId: string, purpose = 'question'): void {
  store.db
    .prepare(
      `INSERT INTO bot_requests (message_id, root_key, to_bot_id, purpose, depth, record)
       VALUES (?, ?, 'bot-1', ?, 0, '{}')`
    )
    .run(messageId, messageId, purpose)
}

function outcome(store: OrchestrationDb, messageId: string): void {
  store.db
    .prepare(`INSERT INTO bot_request_outcomes (message_id, outcome) VALUES (?, 'answered')`)
    .run(messageId)
}

const facts = (store: OrchestrationDb, createdAt: number | null = CREATED_AT) =>
  readBotChatTabFacts(store, { chatId: CHAT, lineage: [CHAT, SUCCESSOR], chatCreatedAt: createdAt })

describe('readBotChatTabFacts provenance', () => {
  it('knows a chat Orca marked when a request opened it', () => {
    const store = open()
    markBotRequestChat(store, CHAT)
    expect(facts(store, null)).toMatchObject({ requestChat: true, holds: [] })
  })

  it('knows an older chat whose first mail, soon after it was made, was a bot request', () => {
    const store = open()
    mail(store, { id: 'm1', to: ADDRESS })
    request(store, 'm1')
    expect(facts(store).requestChat).toBe(true)
  })

  it("keeps a person's chat: first mail not a request, a request long after it was made, or no time", () => {
    const store = open()
    mail(store, { id: 'm1', to: ADDRESS })
    mail(store, { id: 'm2', to: ADDRESS })
    request(store, 'm2')
    expect(facts(store).requestChat).toBe(false)

    const late = open()
    mail(late, { id: 'm1', to: ADDRESS, at: '2026-11-19 11:00:00' })
    request(late, 'm1')
    expect(facts(late).requestChat).toBe(false)
    expect(facts(late, null).requestChat).toBe(false)
  })
})

describe('readBotChatTabFacts holds', () => {
  function requestChat(): OrchestrationDb {
    const store = open()
    markBotRequestChat(store, CHAT)
    // The request that opened it, read, with no outcome: the failed case, which holds nothing.
    mail(store, { id: 'opening', to: ADDRESS })
    request(store, 'opening')
    return store
  }

  it('holds nothing for a request that failed or was left without an outcome', () => {
    expect(facts(requestChat()).holds).toEqual([])
  })

  it('holds a chat with unread mail, on any session of it', () => {
    const store = requestChat()
    mail(store, { id: 'unread', to: `orca_session_id:${SUCCESSOR}`, read: false })
    expect(facts(store).holds).toEqual(['unread-mail'])
  })

  it('holds a chat that waits on its own question to a bot, until it has an outcome', () => {
    const store = requestChat()
    mail(store, { id: 'asked', from: ADDRESS })
    request(store, 'asked', 'handoff')
    expect(facts(store).holds).toEqual(['own-request'])
    outcome(store, 'asked')
    expect(facts(store).holds).toEqual([])
  })

  it('reads the newest mail to or from it as activity', () => {
    const store = requestChat()
    mail(store, { id: 'later', from: ADDRESS, at: '2026-11-20 08:00:00' })
    outcome(store, 'later')
    expect(facts(store).lastMailAt).toBe(sqliteUtcMs('2026-11-20 08:00:00'))
  })
})
