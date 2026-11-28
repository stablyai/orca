import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BotItemsStore } from '../../../../../bots/bot-items-store'
import {
  BOT_ITEMS_OPS,
  callBotItemsOp,
  type BotItemsRemote
} from '../../../../../bots/bot-items-ops'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import type * as RecipientRouting from './recipient-routing'
import { DOCS_CHAT, RANGER_CHAT, RANGER_THREAD, setupBotMail } from './bot-recipient.test-fixture'

vi.mock(
  '../../../../../bots/bot-session-tabs',
  async () => (await import('./bot-recipient.test-fixture')).botSessionTabsMock
)
vi.mock(
  '../../../../../bots/bot-chat-session',
  async () => (await import('./bot-recipient.test-fixture')).botChatSessionMock
)
vi.mock(
  '../../../../../bots/bot-chat-mail-hold',
  async () => (await import('./bot-recipient.test-fixture')).botChatMailHoldMock
)
vi.mock(
  '../../../../../bots/bot-chat-status-line',
  async () => (await import('./bot-recipient.test-fixture')).botChatStatusLineMock
)
vi.mock('./recipient-routing', async (original) =>
  (await import('./bot-recipient.test-fixture')).recipientRoutingMock(
    await original<typeof RecipientRouting>()
  )
)

const RANGER = { kind: 'bot', botId: 'ranger', chatId: RANGER_THREAD } as const

describe('a bot status to another bot is recorded on its item, not delivered', () => {
  const harness = createOrchestrationRpcHarness()
  let mail: ReturnType<typeof setupBotMail>
  let items: BotItemsStore

  beforeEach(() => {
    mail = setupBotMail(harness)
    items = BotItemsStore.open(':memory:')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: one async wrapper per op of the real store, as the DB worker answers them.
    const remote = Object.fromEntries(
      BOT_ITEMS_OPS.map((op) => [op, async (...args: unknown[]) => callBotItemsOp(items, op, args)])
    ) as unknown as BotItemsRemote
    vi.spyOn(mail.runtime.botItems, 'store').mockReturnValue(remote)
    vi.spyOn(mail.runtime.botItems, 'chatRootOf').mockImplementation((id) => id)
  })
  afterEach(() => {
    items.dispose()
    vi.restoreAllMocks()
    harness.cleanup()
  })

  const addItem = (title: string) =>
    items.add(
      {
        ownerBotId: 'ranger',
        chatId: RANGER_THREAD,
        source: { kind: 'thread', title: null },
        title,
        status: 'working',
        links: []
      },
      RANGER
    )
  const messageCount = () => mail.db.db.prepare('SELECT COUNT(*) AS n FROM messages').get()
  const comments = (uid: string) =>
    items.events(uid, 0, 50).filter((event) => event.kind === 'commented')

  it.each([
    ['another bot', 'bot:Docs'],
    ["the bot's own other chat", `orca_session_id:${RANGER_CHAT}`]
  ])('to %s: no message, no wake, a note on the item, a receipt naming it', async (_, to) => {
    const { uid } = addItem('Fix the install docs')
    const number = items.get(uid)!.number
    const receipt = await mail.sent(RANGER_THREAD, { to, type: 'status', body: 'PR is up' })

    expect(messageCount()).toEqual({ n: 0 })
    expect(mail.runtime.notifyMessageArrived).not.toHaveBeenCalled()
    expect(comments(uid)).toHaveLength(1)
    expect(comments(uid)[0]!.data.text).toContain('PR is up')
    expect(receipt.recorded).toEqual({ item: number, bot: 'Ranger' })
    expect(receipt.next).toMatch(
      new RegExp(`^Done: (Docs|Your other chat) has this on item ${number} `)
    )
    expect(receipt.next).toContain(`orca bot item show ${number}`)
    expect(receipt.next).toContain("don't resend it")
  })

  it('refuses, naming the items, when the chat has several open items or none', async () => {
    await expect(
      mail.send(RANGER_THREAD, { to: 'bot:Docs', type: 'status', body: 'b' })
    ).rejects.toThrow(/No open item.*--type question or --type handoff/)
    const first = items.get(addItem('One').uid)!.number
    const second = items.get(addItem('Two').uid)!.number
    await expect(
      mail.send(RANGER_THREAD, { to: 'bot:Docs', type: 'status', body: 'b' })
    ).rejects.toThrow(
      new RegExp(`${second} \\(Two\\), ${first} \\(One\\).*Send it again once, with --item <n>`)
    )
    expect(messageCount()).toEqual({ n: 0 })
    expect(mail.runtime.notifyMessageArrived).not.toHaveBeenCalled()
  })

  it("records on the sender's own item that --item names, with no wake", async () => {
    const { uid } = addItem('Mine')
    addItem('Other')
    const number = items.get(uid)!.number
    const receipt = await mail.sent(RANGER_THREAD, {
      to: 'bot:Docs',
      type: 'status',
      item: String(number),
      body: 'b'
    })
    expect(receipt.recorded).toEqual({ item: number, bot: 'Ranger' })
    expect(comments(uid)).toHaveLength(1)
    expect(messageCount()).toEqual({ n: 0 })
    expect(mail.runtime.notifyMessageArrived).not.toHaveBeenCalled()
  })

  it('skips closed items and keeps the same-chat refusal', async () => {
    const closed = addItem('Done already').uid
    items.close(closed, 'done', undefined, RANGER)
    const { uid } = addItem('Still open')
    await mail.send(RANGER_THREAD, { to: 'bot:Docs', type: 'status', body: 'b' })
    expect(comments(uid)).toHaveLength(1)
    expect(comments(closed)).toHaveLength(0)

    await expect(
      mail.send(RANGER_THREAD, {
        to: `orca_session_id:${RANGER_THREAD}`,
        type: 'status',
        body: 'b'
      })
    ).rejects.toThrow(/already in that chat/)
    expect(comments(uid)).toHaveLength(1)
  })

  it.each(['question', 'handoff'])('a %s still lands as mail and wakes the bot', async (type) => {
    addItem('Fix the install docs')
    await mail.send(RANGER_THREAD, { to: 'bot:Docs', type, body: 'b' })

    expect(messageCount()).toEqual({ n: 1 })
    expect(mail.runtime.notifyMessageArrived).toHaveBeenCalledTimes(1)
  })

  it('a reply to a question still wakes the asker', async () => {
    const asked = await mail.sent(RANGER_THREAD, { to: 'bot:Docs', type: 'question', body: 'b' })
    await mail.reply(DOCS_CHAT, { id: asked.message.id, body: 'yes' })

    expect(messageCount()).toEqual({ n: 2 })
    expect(mail.runtime.notifyMessageArrived).toHaveBeenCalledTimes(2)
  })
})
