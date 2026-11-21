import '../../../dispatch/testing/unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import type * as RecipientRouting from './recipient-routing'
import {
  DOCS_CHAT,
  DOCS_THREAD,
  failureHeldChats,
  journals,
  message,
  noteChats,
  notes,
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

// A Home Chat whose last turn failed holds other agents' mail until its owner continues it, so a
// request by the agent's name queues there with the owner's own follow-ups.
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

  it('queues in the Home Chat, opens no chat, notes nothing, and tells the sender why it waits', async () => {
    failureHeldChats.add(DOCS_CHAT)
    const receipt = await sent(RANGER_THREAD, { to: 'bot:Docs', type: 'question' })
    expect(receipt.message.to_handle).toBe(`orca_session_id:${DOCS_CHAT}`)
    // Its mail goes to the Home Chat's mailbox, which queues it behind the failed turn.
    expect(runtime.notifyMessageArrived).toHaveBeenCalledWith(
      `orca_session_id:${DOCS_CHAT}`,
      'question'
    )
    expect(startBotSession).not.toHaveBeenCalled()
    expect(notes).toEqual([])
    expect(receipt.next).toBe(
      "Docs's Home chat is paused after a failed turn, so this is queued there and has not started. It runs when Docs's owner resumes or sends in that chat, or at the usage-limit reset if automatic continue is on. Its answer comes back as usual once it runs. Tell the asker in one line that it is waiting on that."
    )
    // The answer still finds its way back to the asker.
    await expect(
      reply(DOCS_CHAT, { id: receipt.message.id, body: 'the answer' })
    ).resolves.toMatchObject({ message: { to_handle: `orca_session_id:${RANGER_THREAD}` } })
  })

  it('queues in the Home Chat the store chose when a new one replaced the one on record', async () => {
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
    expect(receipt.message.to_handle).toBe(`orca_session_id:${newHome}`)
    expect(receipt.next).toContain('paused after a failed turn')
    expect(noteChats).toEqual([])
  })

  it('queues once when the same send is retried', async () => {
    failureHeldChats.add(DOCS_CHAT)
    await sent(RANGER_THREAD, { to: 'bot:Docs', type: 'handoff' })
    await expect(sent(RANGER_THREAD, { to: 'bot:Docs', type: 'handoff' })).resolves.toMatchObject({
      duplicate: true
    })
    expect(startBotSession).not.toHaveBeenCalled()
  })

  it('lands in the Home Chat as before once it is not held', async () => {
    const receipt = await sent(RANGER_THREAD, { to: 'bot:Docs', type: 'question' })
    expect(receipt.message.to_handle).toBe(`orca_session_id:${DOCS_CHAT}`)
    expect(startBotSession).not.toHaveBeenCalled()
    expect(notes).toEqual([])
    expect(receipt.next).not.toContain('failed turn')
  })

  // --chat naming the Home Chat by its id queues there the same way as the agent's name.
  it('queues in a held Home Chat named with --chat, with the same receipt', async () => {
    for (const bot of bots.filter((entry) => entry.id === 'docs')) {
      bot.chatSessionId = DOCS_CHAT
    }
    failureHeldChats.add(DOCS_CHAT)
    const receipt = await sent(RANGER_THREAD, { to: 'bot:Docs', type: 'handoff', chat: DOCS_CHAT })
    expect(receipt.message.to_handle).toBe(`orca_session_id:${DOCS_CHAT}`)
    expect(receipt.next).toMatch(
      /^Docs's Home chat is paused after a failed turn, so this is queued there/
    )
    await expect(
      sent(RANGER_THREAD, { to: 'bot:Docs', type: 'handoff', chat: DOCS_CHAT })
    ).resolves.toMatchObject({ duplicate: true })
    expect(startBotSession).not.toHaveBeenCalled()
    expect(notes).toEqual([])
  })

  it('queues in any other held chat named with --chat, naming that chat', async () => {
    failureHeldChats.add(DOCS_THREAD)
    const receipt = await sent(RANGER_THREAD, {
      to: 'bot:Docs',
      type: 'question',
      chat: DOCS_THREAD
    })
    expect(receipt.message.to_handle).toBe(`orca_session_id:${DOCS_THREAD}`)
    expect(receipt.next).toMatch(
      new RegExp(
        `^Docs's chat ${DOCS_THREAD} is paused after a failed turn, so this is queued there`
      )
    )
    expect(startBotSession).not.toHaveBeenCalled()
    expect(notes).toEqual([])
  })

  it('queues in a held Home Chat reached by its session address, status included', async () => {
    for (const bot of bots.filter((entry) => entry.id === 'docs')) {
      bot.chatSessionId = DOCS_CHAT
    }
    failureHeldChats.add(DOCS_CHAT)
    const receipt = await sent(RANGER_THREAD, {
      to: `orca_session_id:${DOCS_CHAT}`,
      type: 'status'
    })
    expect(receipt.message.to_handle).toBe(`orca_session_id:${DOCS_CHAT}`)
    expect(receipt.next).toMatch(
      /^Docs's Home chat is paused after a failed turn.* Nothing comes back\.$/
    )
    expect(startBotSession).not.toHaveBeenCalled()
    expect(notes).toEqual([])
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
