import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTestBot } from '../../../bots/bot.test-fixture'
import type { BotItemActor } from '../../../../shared/bots/bot-items'
import type { BotItemMail, BotItemRecord } from '../../../bots/bot-items-schema'
import { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { sendBotItemMail } from './bots-items-mail'

const notes = vi.hoisted(() => ({ append: vi.fn() }))
vi.mock('../../../bots/bot-item-chat-notes', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  appendBotItemNote: notes.append
}))

// `closed`: the item's chat takes no mail, so it lands in Home Chat.
const mailbox = vi.hoisted(() => ({ closed: false }))
vi.mock('./bots-chats', () => ({
  botChatTakingMail: async (_runtime: unknown, _bot: unknown, chatId: string) =>
    mailbox.closed ? null : { sessionId: chatId }
}))
vi.mock('../../../bots/bot-chat-session', () => ({
  runtimeBotChats: () => ({ ensure: async () => 'home-chat' })
}))
// A room session still in a room takes the owner's change as their post there.
const rooms = vi.hoisted(() => ({ live: new Set<string>(), posted: [] as unknown[] }))
vi.mock('../../../bots/bot-group-runtime', () => ({ runtimeBotGroups: () => ({}) }))
vi.mock('../../../bots/bot-group-item-posts', () => ({
  postGroupItemMail: async (_groups: unknown, sessionId: string, mail: unknown) => {
    if (!rooms.live.has(sessionId)) {
      return false
    }
    rooms.posted.push({ sessionId, mail })
    return true
  }
}))

const CHAT = '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e'
const dbs: OrchestrationDb[] = []

afterEach(() => {
  dbs.splice(0).forEach((db) => db.close())
  notes.append.mockClear()
  mailbox.closed = false
})

const item: BotItemRecord = {
  uid: 'item-uid',
  number: 4,
  ownerBotId: 'ranger',
  chatId: CHAT,
  source: { kind: 'home', title: 'Home Chat' },
  madeBy: null,
  title: 'Share dialog',
  description: null,
  doneMeans: null,
  status: 'working',
  questionEvent: null,
  closeNote: null,
  snoozedUntil: null,
  version: 3,
  lastEventId: 12,
  lastActivityAt: 1,
  createdAt: 1,
  updatedAt: 1,
  closedAt: null
}

function owed(actor: BotItemActor = { kind: 'owner' }): BotItemMail {
  const event = (id: number, kind: string, data: Record<string, unknown>) => ({
    id,
    itemUid: item.uid,
    kind,
    actor,
    data,
    createdAt: 1
  })
  return {
    id: 11,
    ownerBotId: 'ranger',
    chatId: CHAT,
    changes: [
      { event: event(11, 'commented', { text: 'Use the short link' }), item },
      { event: event(12, 'status', { from: 'needs_you', to: 'working' }), item }
    ]
  }
}

function runtimeOf(db: OrchestrationDb, chats: Record<string, string | null>): OrcaRuntimeService {
  const bot = makeTestBot({ id: 'ranger', name: 'Ranger', chatSessionId: 'home-chat' })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: item mail reads only these.
  return {
    getOrchestrationDb: () => db,
    bots: { list: () => [bot] },
    notifyMessageArrived: () => {},
    botItems: {
      chatRootOf: (id: string) => id,
      chatSource: () => ({ kind: 'chat', title: null }),
      owningChat: ({ chatId }: { chatId: string }) =>
        chatId in chats
          ? { id: chatId, kind: 'chat', title: chats[chatId] }
          : { id: chatId, kind: 'chat', title: null, gone: true }
    }
  } as unknown as OrcaRuntimeService
}

describe("the item chat's note for another chat's write", () => {
  const byChat = (chatId: string): BotItemActor => ({ kind: 'bot', botId: 'ranger', chatId })

  // Each send gets its own mailbox: one already holding the mail sends nothing again.
  const freshDb = () => {
    const db = new OrchestrationDb(':memory:')
    dbs.push(db)
    return db
  }

  it('names the chat that made it', async () => {
    const runtime = runtimeOf(freshDb(), { 'chat-a': 'Debug Slack replies' })
    await sendBotItemMail(runtime, owed(byChat('chat-a')))
    expect(notes.append).toHaveBeenCalledWith(
      CHAT,
      expect.objectContaining({
        by: { kind: 'chat', chatId: 'chat-a', title: 'Debug Slack replies' }
      })
    )
  })

  it('says another chat once that chat is gone, and the owner for the owner', async () => {
    await sendBotItemMail(runtimeOf(freshDb(), {}), owed(byChat('chat-gone')))
    await sendBotItemMail(runtimeOf(freshDb(), {}), owed())
    expect(notes.append.mock.calls.map(([, note]) => note.by)).toEqual(['other-chat', 'owner'])
  })

  it('draws none in Home when Home made the change and the closed item chat mailed Home', async () => {
    mailbox.closed = true
    const db = freshDb()
    await sendBotItemMail(runtimeOf(db, { 'home-chat': null }), owed(byChat('home-chat')))
    expect(db.getMessageById('msg_item_e11')?.to_handle).toBe('orca_session_id:home-chat')
    expect(notes.append).not.toHaveBeenCalled()
  })
})

describe('item mail for a group room session', () => {
  const ROOM = 'bot-group-member-room-1'
  const inRoom = (actor?: BotItemActor): BotItemMail => ({
    ...owed(actor),
    chatId: ROOM,
    changes: owed(actor).changes.map((change) => ({ ...change, item: { ...item, chatId: ROOM } }))
  })
  const mailDb = () => {
    const db = new OrchestrationDb(':memory:')
    dbs.push(db)
    return db
  }
  afterEach(() => {
    rooms.live.clear()
    rooms.posted.length = 0
  })

  it("posts the owner's change in the room, whole, and mails nothing", async () => {
    rooms.live.add(ROOM)
    const db = mailDb()
    expect(await sendBotItemMail(runtimeOf(db, {}), inRoom())).toBe(true)
    expect(rooms.posted).toEqual([
      {
        sessionId: ROOM,
        mail: expect.objectContaining({
          id: 'msg_item_e11',
          subject: expect.stringContaining('item 4'),
          body: expect.stringContaining('Use the short link'),
          images: []
        })
      }
    ])
    expect(db.getMessageById('msg_item_e11')).toBeUndefined()
  })

  it('mails Home when no room has the session, or another of the bot’s chats made the change', async () => {
    const gone = mailDb()
    await sendBotItemMail(runtimeOf(gone, {}), inRoom())
    expect(gone.getMessageById('msg_item_e11')?.to_handle).toBe('orca_session_id:home-chat')
    rooms.live.add(ROOM)
    const byBot = mailDb()
    await sendBotItemMail(
      runtimeOf(byBot, { 'chat-a': null }),
      inRoom({ kind: 'bot', botId: 'ranger', chatId: 'chat-a' })
    )
    expect(rooms.posted).toEqual([])
    expect(byBot.getMessageById('msg_item_e11')?.to_handle).toBe('orca_session_id:home-chat')
  })
})

describe('item mail', () => {
  it("stores one message in the item chat's mailbox for a write, and none when sent again", async () => {
    const db = new OrchestrationDb(':memory:')
    dbs.push(db)
    const notified: string[] = []
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: item mail reads only the orchestration database, the bot list and the arrival notice.
    const runtime = {
      getOrchestrationDb: () => db,
      bots: { list: () => [makeTestBot({ id: 'ranger', name: 'Ranger' })] },
      notifyMessageArrived: (to: string) => notified.push(to)
    } as unknown as OrcaRuntimeService

    expect(await sendBotItemMail(runtime, owed())).toBe(true)
    expect(await sendBotItemMail(runtime, owed())).toBe(true)

    const message = db.getMessageById('msg_item_e11')
    expect(message).toMatchObject({
      from_handle: 'orca:items',
      to_handle: `orca_session_id:${CHAT}`,
      type: 'status'
    })
    expect(message?.body).toContain('Use the short link')
    expect(JSON.parse(String(message?.payload))).toEqual({
      botItems: [
        { uid: 'item-uid', number: 4, eventId: 'e11', kind: 'commented' },
        { uid: 'item-uid', number: 4, eventId: 'e12', kind: 'status' }
      ]
    })
    expect(notified).toEqual([`orca_session_id:${CHAT}`])
  })
})
