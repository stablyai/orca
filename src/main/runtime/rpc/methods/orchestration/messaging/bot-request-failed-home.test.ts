import '../../../dispatch/testing/unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import type * as RecipientRouting from './recipient-routing'
import {
  DOCS_CHAT,
  DOCS_REQUEST,
  DOCS_THREAD,
  failureHeldChats,
  journals,
  message,
  noteChats,
  notes,
  RANGER_CHAT,
  RANGER_THREAD,
  setupBotMail,
  startBotSession,
  withChat
} from './bot-recipient.test-fixture'

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
vi.mock('./recipient-routing', async (importOriginal) =>
  (await import('./bot-recipient.test-fixture')).recipientRoutingMock(
    await importOriginal<typeof RecipientRouting>()
  )
)

// A Home Chat whose last turn failed holds other agents' mail until its owner sends, so a request
// by the bot's name must not wait there unread.
describe("a request by a bot's name when its Home Chat's last turn failed", () => {
  const h = createOrchestrationRpcHarness()
  let runtime: OrcaRuntimeService
  let bots: ReturnType<typeof setupBotMail>['bots']
  let sent: ReturnType<typeof setupBotMail>['sent']
  let reply: ReturnType<typeof setupBotMail>['reply']

  beforeEach(() => {
    ;({ runtime, bots, sent, reply } = setupBotMail(h))
    journals[RANGER_THREAD] = [message('ask')]
  })
  afterEach(() => h.cleanup())

  it('starts a chat of its own that wakes the bot, and tells the Home Chat where it went', async () => {
    failureHeldChats.add(DOCS_CHAT)
    const receipt = await sent(RANGER_THREAD, { to: 'bot:Docs', type: 'question' })
    expect(receipt.message.to_handle).toBe(`orca_session_id:${DOCS_REQUEST}`)
    expect(runtime.notifyMessageArrived).toHaveBeenCalledWith(
      `orca_session_id:${DOCS_REQUEST}`,
      'question'
    )
    expect(runtime.notifyMessageArrived).not.toHaveBeenCalledWith(
      `orca_session_id:${DOCS_CHAT}`,
      expect.anything()
    )
    expect(notes).toEqual([
      'Request from Ranger, for you; it runs in its own conversation: Ranger: update the install docs'
    ])
    expect(noteChats).toEqual([DOCS_CHAT])
    // The sender is told where it went, so follow-ups go there.
    expect(receipt.next).toContain(
      `Docs's chat ${DOCS_CHAT} is stopped after a failed turn, so this went to a new chat of Docs instead (--chat ${DOCS_REQUEST}).`
    )
    // The answer still finds its way back to the asker.
    await expect(
      reply(DOCS_REQUEST, { id: receipt.message.id, body: 'the answer' })
    ).resolves.toMatchObject({ message: { to_handle: `orca_session_id:${RANGER_THREAD}` } })
  })

  it('notes the Home Chat it chose when a new Home Chat replaced the one the bot named', async () => {
    const newHome = '66666666-6666-4666-8666-666666666666'
    // The bot still names its old Home Chat; the store hands over the new one.
    for (const bot of bots.filter((entry) => entry.id === 'docs')) {
      bot.chatSessionId = DOCS_CHAT
    }
    withChat.mockImplementation((_botId: string, work: (sessionId: string) => unknown) =>
      work(newHome)
    )
    failureHeldChats.add(newHome)
    const receipt = await sent(RANGER_THREAD, { to: 'bot:Docs', type: 'question' })
    expect(receipt.message.to_handle).toBe(`orca_session_id:${DOCS_REQUEST}`)
    expect(noteChats).toEqual([newHome])
  })

  it('opens one chat when the same send is retried', async () => {
    failureHeldChats.add(DOCS_CHAT)
    await sent(RANGER_THREAD, { to: 'bot:Docs', type: 'handoff' })
    await expect(sent(RANGER_THREAD, { to: 'bot:Docs', type: 'handoff' })).resolves.toMatchObject({
      duplicate: true
    })
    expect(startBotSession).toHaveBeenCalledTimes(1)
  })

  it('lands in the Home Chat as before once it is not held', async () => {
    const receipt = await sent(RANGER_THREAD, { to: 'bot:Docs', type: 'question' })
    expect(receipt.message.to_handle).toBe(`orca_session_id:${DOCS_CHAT}`)
    expect(startBotSession).not.toHaveBeenCalled()
    expect(notes).toEqual([])
    expect(receipt.next).not.toContain('failed turn')
  })

  // The stall this fixes came through --chat naming the Home Chat by its id, so a chat the sender
  // names is redirected the same way when a failed turn holds it.
  it('starts a chat of its own for a held chat named with --chat, noted in that chat', async () => {
    failureHeldChats.add(RANGER_CHAT)
    journals[DOCS_CHAT] = [message('ask')]
    const receipt = await sent(DOCS_CHAT, { to: 'bot:Ranger', type: 'question', chat: RANGER_CHAT })
    expect(receipt.message.to_handle).toBe(`orca_session_id:${DOCS_REQUEST}`)
    expect(startBotSession).toHaveBeenCalledTimes(1)
    expect(noteChats).toEqual([RANGER_CHAT])
    expect(receipt.next).toContain(
      `Ranger's chat ${RANGER_CHAT} is stopped after a failed turn, so this went to a new chat of Ranger instead (--chat ${DOCS_REQUEST}).`
    )
  })

  it('redirects a named Home Chat held by a failed turn, as the bot name does', async () => {
    failureHeldChats.add(DOCS_CHAT)
    const receipt = await sent(RANGER_THREAD, { to: 'bot:Docs', type: 'handoff', chat: DOCS_CHAT })
    expect(receipt.message.to_handle).toBe(`orca_session_id:${DOCS_REQUEST}`)
    expect(noteChats).toEqual([DOCS_CHAT])
    await expect(
      sent(RANGER_THREAD, { to: 'bot:Docs', type: 'handoff', chat: DOCS_CHAT })
    ).resolves.toMatchObject({ duplicate: true })
    expect(startBotSession).toHaveBeenCalledTimes(1)
  })

  it('leaves status in a held chat it was named for: it asks for nothing', async () => {
    failureHeldChats.add(DOCS_CHAT)
    const receipt = await sent(RANGER_THREAD, { to: 'bot:Docs', type: 'status', chat: DOCS_CHAT })
    expect(receipt.message.to_handle).toBe(`orca_session_id:${DOCS_CHAT}`)
    expect(startBotSession).not.toHaveBeenCalled()
  })

  it('mails a named chat no failed turn holds as before', async () => {
    failureHeldChats.add(DOCS_CHAT)
    const receipt = await sent(RANGER_THREAD, {
      to: 'bot:Docs',
      type: 'question',
      chat: DOCS_THREAD
    })
    expect(receipt.message.to_handle).toBe(`orca_session_id:${DOCS_THREAD}`)
    expect(startBotSession).not.toHaveBeenCalled()
  })
})
