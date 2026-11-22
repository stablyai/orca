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

  it('names the chat Orca closed in Home’s note, so Home can reopen it; a chat closed by hand is not named', async () => {
    mailbox.closed = true
    const db = freshDb()
    const runtime = runtimeOf(db, { [CHAT]: 'Share dialog fix' })
    const autoClosed = new Set([CHAT])
    Object.assign(runtime, {
      botChatAutoClose: {
        autoClosedAt: (_botId: string, chatId: string) => (autoClosed.has(chatId) ? 5 : null)
      }
    })
    await sendBotItemMail(runtime, owed())
    expect(db.getMessageById('msg_item_e11')?.to_handle).toBe('orca_session_id:home-chat')
    expect(notes.append).toHaveBeenCalledWith(
      'home-chat',
      expect.objectContaining({ closedChat: { chatId: CHAT, title: 'Share dialog fix' } })
    )

    autoClosed.clear()
    await sendBotItemMail(runtimeOf(freshDb(), { [CHAT]: 'Share dialog fix' }), owed())
    expect(notes.append.mock.calls[1]?.[1]).not.toHaveProperty('closedChat')
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
