import '../../../dispatch/testing/unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../../../shared/bot-types'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { RpcContext } from '../../../core'
import type { Automation } from '../../../../../../shared/automations/automation-definition'
import type { AutomationRun } from '../../../../../../shared/automations/history/automation-run'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import { makeTestBot } from '../../../../../bots/bot.test-fixture'
import { replyFollowUp } from './reply-follow-up'
import { sendToBot } from './bot-request-send'
import type * as RecipientRouting from './recipient-routing'
import {
  askedBy,
  caller,
  cards,
  DOCS_CHAT,
  DOCS_REQUEST,
  DOCS_THREAD,
  journals,
  message,
  notes,
  RANGER_CHAT,
  RANGER_THREAD,
  sessionsOf,
  startBotSession,
  setUserConversationName,
  setupBotMail,
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

describe('mail to a bot', () => {
  const h = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let bots: Bot[]
  let send: ReturnType<typeof setupBotMail>['send']
  let sent: ReturnType<typeof setupBotMail>['sent']
  let reply: ReturnType<typeof setupBotMail>['reply']
  let publishTab: ReturnType<typeof setupBotMail>['publishTab']
  let conversationTurn: ReturnType<typeof setupBotMail>['conversationTurn']

  beforeEach(() => {
    ;({ db, runtime, bots, send, sent, reply, publishTab, conversationTurn } = setupBotMail(h))
  })
  afterEach(() => h.cleanup())

  it("lands a teammate's request in the bot's Home Chat, with Orca's record of who asked", async () => {
    journals[RANGER_THREAD] = [message('ask', askedBy('U_DANA', 'Dana'))]
    // Sent on the Slack thread's own turn, which answers there, not on a card.
    conversationTurn.mockReturnValue(true)
    const receipt = await sent(RANGER_THREAD, { to: 'bot:docs', type: 'handoff' })
    expect(receipt.message).toMatchObject({
      to_handle: `orca_session_id:${DOCS_CHAT}`,
      type: 'handoff'
    })
    expect(startBotSession).not.toHaveBeenCalled()
    expect(cards).toEqual([])
    expect(notes).toEqual([])
    const id = receipt.message.id
    expect(JSON.parse(receipt.message.payload)).toEqual({
      botRequest: {
        from: 'Ranger',
        for: 'Dana on Slack',
        kind: 'handoff: the job is yours now',
        answer: `orca slack post slack:T1:C1:1712.1 "<your answer>", then orca orchestration reply --id ${id} --body "Posted in the thread."`,
        answerAppears: 'the Slack thread where Dana on Slack asked, as you',
        ifThePostIsRefused: `orca orchestration reply --id ${id} --body "<your answer>"; Ranger passes it on`
      }
    })
    expect(receipt.next).toMatch(/Docs has it now and answers in this thread itself/)
    const request = db.getBotRequest(id)
    expect(request).toMatchObject({ from_bot_id: 'ranger', to_bot_id: 'docs', depth: 1 })
    expect(JSON.parse(request!.record)).toMatchObject({
      askers: [{ kind: 'person', userId: 'U_DANA', workspaceId: 'T1', role: 'member' }],
      request: 'ask',
      conversation: { source: 'slack', externalId: 'T1:C1:1712.1:UBOT' }
    })
  })

  it("lands a teammate's request mailed straight to a chat in that chat", async () => {
    journals[RANGER_THREAD] = [message('ask', askedBy('U_DANA', 'Dana'))]
    const receipt = await sent(RANGER_THREAD, {
      to: `orca_session_id:${DOCS_THREAD}`,
      type: 'handoff'
    })
    expect(receipt.message.to_handle).toBe(`orca_session_id:${DOCS_THREAD}`)
    expect(startBotSession).not.toHaveBeenCalled()
  })

  it("lands a teammate's request about a chat (an item comment) in that chat, with who asked", async () => {
    journals[RANGER_THREAD] = [message('ask', askedBy('U_DANA', 'Dana'))]
    const sender = caller(RANGER_THREAD)
    const sent = await sendToBot(
      { runtime, orchestrationCaller: sender, recordMutationReceipt: undefined },
      {
        params: { subject: 'Ranger commented', body: 'v2 spec', type: 'status' },
        from: sender.address,
        to: `orca_session_id:${DOCS_CHAT}`,
        sender,
        routing: { run: undefined },
        messageId: 'msg_item_comment1'
      }
    )
    expect(sent).not.toBeNull()
    expect(db.getMessageById('msg_item_comment1')?.to_handle).toBe(`orca_session_id:${DOCS_CHAT}`)
    const request = db.getBotRequest('msg_item_comment1')
    expect(request).toMatchObject({ from_bot_id: 'ranger', to_bot_id: 'docs', depth: 1 })
    expect(JSON.parse(request!.record)).toMatchObject({
      askers: [{ kind: 'person', userId: 'U_DANA', workspaceId: 'T1' }],
      askedBy: [{ kind: 'person', userId: 'U_DANA' }]
    })
  })

  it("mails the owner's request to the bot's Chat, answered back by mail", async () => {
    journals[RANGER_THREAD] = [message('ask')]
    const receipt = await sent(RANGER_THREAD, { to: 'bot:Docs', type: 'question' })
    expect(receipt.message.to_handle).toBe(`orca_session_id:${DOCS_CHAT}`)
    expect(startBotSession).not.toHaveBeenCalled()
    expect(JSON.parse(receipt.message.payload).botRequest).toMatchObject({
      for: 'your owner',
      answer: `orca orchestration reply --id ${receipt.message.id} --body "<your answer>"`,
      answerAppears: "Ranger's conversation, waking it to finish the job"
    })
  })

  it("cards the owner's request in the sender's chat, and a refusal as not sent", async () => {
    journals[RANGER_THREAD] = [message('ask')]
    const receipt = await sent(RANGER_THREAD, { to: 'bot:Docs', type: 'handoff', subject: 'Docs' })
    expect(cards).toEqual([
      {
        sessionId: RANGER_THREAD,
        body: expect.objectContaining({
          presentation: 'bot-request',
          botRequest: expect.objectContaining({
            toBotId: 'docs',
            purpose: 'handoff',
            messageId: receipt.message.id
          })
        })
      }
    ])
    bots.find((bot) => bot.id === 'docs')!.paused = true
    journals[RANGER_THREAD]!.push(message('again'))
    await expect(send(RANGER_THREAD, { to: 'bot:Docs', type: 'question' })).rejects.toThrow(
      /paused/
    )
    expect(cards.at(-1)?.body).toMatchObject({
      botRequest: { toBotName: 'Docs', refusal: 'bot_paused' }
    })
    expect(cards.at(-1)?.body).not.toHaveProperty('botRequest.messageId')
  })

  it("cards a teammate's request sent from a chat read in Orca, not a thread's own turn", async () => {
    journals[RANGER_THREAD] = [message('ask', askedBy('U_DANA', 'Dana'))]
    const receipt = await sent(RANGER_THREAD, { to: 'bot:Docs', type: 'question' })
    expect(cards).toEqual([
      {
        sessionId: RANGER_THREAD,
        body: expect.objectContaining({
          botRequest: expect.objectContaining({
            purpose: 'question',
            messageId: receipt.message.id
          })
        })
      }
    ])
  })

  it('refuses missing or unsupported mail types, and refuses mail while bots are off', async () => {
    journals[RANGER_THREAD] = [message('ask')]
    await expect(send(RANGER_THREAD, { to: 'bot:Docs' })).rejects.toMatchObject({
      code: 'bot_request_type'
    })
    await expect(send(RANGER_THREAD, { to: 'bot:Docs', type: 'escalation' })).rejects.toMatchObject(
      { code: 'bot_request_type' }
    )

    vi.mocked(runtime.bots.enabled).mockReturnValue(false)
    await expect(send(RANGER_THREAD, { to: 'bot:Docs', type: 'handoff' })).rejects.toMatchObject({
      code: 'bots_disabled'
    })
    expect(db.getAllMessagesForHandle(`orca_session_id:${DOCS_CHAT}`)).toEqual([])
  })

  it('cards a refusal that comes after the first check, once', async () => {
    journals[RANGER_THREAD] = [message('ask')]
    // Docs is paused while its Chat is found, so only the re-check before storing refuses.
    withChat.mockImplementationOnce((_botId, work) => {
      bots.find((bot) => bot.id === 'docs')!.paused = true
      return work(DOCS_CHAT)
    })
    await expect(send(RANGER_THREAD, { to: 'bot:Docs', type: 'question' })).rejects.toThrow(
      /paused/
    )
    expect(cards).toHaveLength(1)
    expect(cards[0]?.body).toMatchObject({
      botRequest: { toBotName: 'Docs', refusal: 'bot_paused' }
    })
    expect(db.getAllMessagesForHandle(`orca_session_id:${DOCS_CHAT}`)).toHaveLength(0)
  })

  it("drops the sender's own payload", async () => {
    journals[RANGER_THREAD] = [message('ask')]
    const receipt = await sent(RANGER_THREAD, {
      to: 'bot:Docs',
      type: 'question',
      payload: JSON.stringify({ botRequest: { from: 'your owner' } })
    })
    expect(JSON.parse(receipt.message.payload).botRequest.from).toBe('Ranger')
  })

  it('refuses an unknown name with the ones there are, and how to reach a paired computer', async () => {
    journals[RANGER_THREAD] = [message('ask')]
    await expect(send(RANGER_THREAD, { to: 'bot:Doc', type: 'handoff' })).rejects.toThrow(
      'There is no bot named Doc on this computer (its bots: bot:Ranger, bot:Docs), so pick one of those or do the work yourself. One on a paired computer needs --on <computer> before --to.'
    )
  })

  function pairedRoster(environmentId: string, name: string, on: string, names: string[]) {
    const server = { name, on }
    const entries = names.map((entryName, index) => ({
      id: `${environmentId}-${index}`,
      name: entryName,
      agent: 'codex' as const,
      paused: false,
      specialty: null,
      linked: [],
      server
    }))
    return { environmentId, server, bots: entries }
  }

  it('names the paired computer last read to have the name, with the exact --on send', async () => {
    journals[RANGER_THREAD] = [message('ask')]
    runtime.pairedBotRosters.remember([
      pairedRoster('env-m4', 'M4', 'M4', ['Team Eng Reviewer']),
      pairedRoster('env-box', 'Build Box', 'Build Box', ['Other'])
    ])
    await expect(
      send(RANGER_THREAD, { to: 'bot:team eng reviewer', type: 'question' })
    ).rejects.toThrow(
      'There is no bot named team eng reviewer on this computer. Team Eng Reviewer is on M4: use --on M4 --to "bot:Team Eng Reviewer".'
    )
  })

  it('lists each paired computer that has the name', async () => {
    journals[RANGER_THREAD] = [message('ask')]
    runtime.pairedBotRosters.remember([
      pairedRoster('env-m4', 'M4', 'M4', ['Reviewer']),
      pairedRoster('env-box', "Jo's Box", "Jo's Box", ['Reviewer'])
    ])
    await expect(send(RANGER_THREAD, { to: 'bot:Reviewer', type: 'question' })).rejects.toThrow(
      "There is no bot named Reviewer on this computer. Reviewer is on M4: use --on M4 --to bot:Reviewer; Reviewer is on Jo's Box: use --on 'Jo'\\''s Box' --to bot:Reviewer."
    )
  })

  it("takes a request for someone off the bot's Who can ask at every address, carrying who it's for", async () => {
    journals[RANGER_THREAD] = [message('ask', askedBy('U_NORA', 'Nora'))]
    for (const to of [
      'bot:Docs',
      `orca_session_id:${DOCS_CHAT}`,
      `orca_session_id:${DOCS_THREAD}`
    ]) {
      const receipt = await sent(RANGER_THREAD, { to, type: 'handoff', subject: `via ${to}` })
      expect(JSON.parse(db.getBotRequest(receipt.message.id)!.record).askers).toMatchObject([
        { kind: 'person', userId: 'U_NORA' }
      ])
    }
  })

  it('refuses any other kind of mail to a bot', async () => {
    journals[RANGER_THREAD] = [message('ask')]
    await expect(
      send(RANGER_THREAD, { to: `orca_session_id:${DOCS_CHAT}`, type: 'escalation' })
    ).rejects.toThrow(/--type status .* --type question .* or --type handoff/)
  })

  it('delivers status from a bot as information: no job, no answer route, no reply hint, no card', async () => {
    journals[RANGER_THREAD] = [message('ask')]
    const receipt = await sent(RANGER_THREAD, {
      to: 'bot:Docs',
      type: 'status',
      subject: 'Your feature landed'
    })
    expect(receipt.message).toMatchObject({
      to_handle: `orca_session_id:${DOCS_CHAT}`,
      type: 'status'
    })
    expect(JSON.parse(receipt.message.payload).botRequest).toEqual({
      from: 'Ranger',
      for: 'your owner',
      kind: 'status: for your information; there is no job to take and nothing to answer',
      next: 'Use it in your own work if it bears on it. If it needs nothing from you, end your turn with NO_REPLY.'
    })
    expect(receipt.next).toBe('Docs has this as information; nothing comes back.')
    const reader = { party: caller(DOCS_CHAT), sessionId: DOCS_CHAT }
    const original = db.getMessageById(receipt.message.id)!
    expect(replyFollowUp(runtime, db, original, reader)).toEqual({ kind: 'information' })
    await expect(reply(DOCS_CHAT, { id: original.id, body: 'thanks' })).rejects.toThrow(
      'That was status from Ranger, for your information, so there is nothing to answer and nothing was sent.'
    )
    expect(db.getAllMessagesForHandle(`orca_session_id:${RANGER_THREAD}`)).toEqual([])
    expect(cards).toEqual([])
  })

  it("delivers status to the bot's own other chat as information", async () => {
    journals[RANGER_THREAD] = [message('ask')]
    const receipt = await sent(RANGER_THREAD, {
      to: 'bot:Ranger',
      chat: RANGER_CHAT,
      type: 'status',
      subject: 'The release went out'
    })
    expect(receipt.message).toMatchObject({
      to_handle: `orca_session_id:${RANGER_CHAT}`,
      type: 'status'
    })
    expect(JSON.parse(receipt.message.payload).botRequest.kind).toBe(
      'status: for your information; there is no job to take and nothing to answer'
    )
    expect(cards).toEqual([])
  })

  it("lets a teammate's turn send a bot status and then a question", async () => {
    journals[RANGER_THREAD] = [message('ask', askedBy('U_DANA', 'Dana'))]
    const status = await sent(RANGER_THREAD, { to: 'bot:docs', type: 'status' })
    const question = await sent(RANGER_THREAD, { to: 'bot:docs', type: 'question' })
    expect(question.duplicate).toBeUndefined()
    expect(question.message.id).not.toBe(status.message.id)
    expect(question.message.type).toBe('question')
  })

  it("lands --chat in that chat of the bot, its own other chats included, never the sender's", async () => {
    journals[RANGER_THREAD] = [message('ask')]
    const other = await sent(RANGER_THREAD, { to: 'bot:Docs', chat: DOCS_THREAD, type: 'question' })
    expect(other.message.to_handle).toBe(`orca_session_id:${DOCS_THREAD}`)
    const own = await sent(RANGER_THREAD, {
      to: 'bot:Ranger',
      chat: `orca_session_id:${RANGER_CHAT}`,
      type: 'question'
    })
    expect(own.message.to_handle).toBe(`orca_session_id:${RANGER_CHAT}`)
    expect(cards.at(-1)).toMatchObject({
      sessionId: RANGER_THREAD,
      body: { botRequest: { toBotId: 'ranger', messageId: own.message.id } }
    })
    expect(db.getBotRequest(own.message.id)).toMatchObject({
      from_bot_id: 'ranger',
      to_bot_id: 'ranger'
    })
    expect(withChat).not.toHaveBeenCalled()
    await expect(
      send(RANGER_THREAD, { to: 'bot:Ranger', chat: RANGER_THREAD, type: 'question' })
    ).rejects.toThrow('You are already in that chat; nothing was sent.')
  })

  it("lands --item in the chat that owns the item, or the bot's Home Chat once that chat is gone", async () => {
    journals[RANGER_THREAD] = [message('ask')]
    const items = runtime.botItems
    const byNumber = async (number: number) => ({
      number,
      ownerBotId: number === 31 ? 'docs' : 'ranger',
      chatId: DOCS_THREAD,
      source: { kind: 'chat' as const, title: null }
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: routing reads only byNumber and these record fields.
    vi.spyOn(items, 'store').mockReturnValue({ byNumber } as never)
    let gone = true
    vi.spyOn(items, 'owningChat').mockImplementation(() => ({
      id: DOCS_THREAD,
      kind: 'chat',
      title: null,
      ...(gone ? { gone: true as const } : {})
    }))
    vi.spyOn(items, 'chatRootOf').mockImplementation((id) => id)
    const home = await sent(RANGER_THREAD, {
      to: 'bot:Docs',
      item: '31',
      subject: 'Item 31 #1',
      type: 'question'
    })
    expect(home.message.to_handle).toBe(`orca_session_id:${DOCS_CHAT}`)

    gone = false
    const owned = await sent(RANGER_THREAD, {
      to: 'bot:Docs',
      item: '31',
      subject: 'Item 31 #2',
      type: 'question'
    })
    expect(owned.message.to_handle).toBe(`orca_session_id:${DOCS_THREAD}`)
    await expect(
      send(RANGER_THREAD, { to: 'bot:Docs', item: '31', chat: DOCS_THREAD, type: 'question' })
    ).rejects.toThrow('Pass --item or --chat, not both. Nothing was sent.')
    await expect(
      send(RANGER_THREAD, { to: 'bot:Docs', item: '96', subject: 'Item 31 #5', type: 'question' })
    ).rejects.toThrow("Item 96 is not Docs's")
  })

  it('lands its own name in its Home Chat from another of its chats, never from the Home Chat', async () => {
    bots[0] = { ...bots[0], chatSessionId: RANGER_CHAT }
    withChat.mockImplementation((_botId, work) => work(RANGER_CHAT))
    journals[RANGER_THREAD] = [message('ask')]
    journals[RANGER_CHAT] = [message('ask')]
    const home = await sent(RANGER_THREAD, { to: 'bot:Ranger', type: 'handoff' })
    expect(home.message.to_handle).toBe(`orca_session_id:${RANGER_CHAT}`)
    // From a chat that acts for a teammate too, and no chat is started for it.
    journals[RANGER_THREAD].push(message('ask again', askedBy('U_DANA', 'Dana')))
    const teammate = await sent(RANGER_THREAD, { to: 'bot:Ranger', type: 'question' })
    expect(teammate.message.to_handle).toBe(`orca_session_id:${RANGER_CHAT}`)
    expect(startBotSession).not.toHaveBeenCalled()
    await expect(send(RANGER_CHAT, { to: 'bot:Ranger', type: 'handoff' })).rejects.toThrow(
      'You are already in that chat; nothing was sent.'
    )
  })

  /** term_worker, started by Ranger's Slack thread, where Dana asked. */
  function rangerWorker(): string {
    journals[RANGER_THREAD] = [message('ask', askedBy('U_DANA', 'Dana'))]
    const run = db.createRun({
      objective: 'worker scope',
      coordinatorHandle: null,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: caller(RANGER_THREAD).orcaSessionId
    })
    const task = db.createTask({ runId: run.id, spec: 'worker' })
    return db.createDispatchContext({
      taskId: task.id,
      assigneeHandle: 'term_worker',
      creator: { kind: 'session', orcaSessionId: caller(RANGER_THREAD).orcaSessionId },
      maxDepth: 2
    }).id
  }
  const workerSend = async (params: Record<string, unknown>) =>
    JSON.parse(
      JSON.stringify(
        await h.call(
          'orchestration.send',
          { from: 'term_worker', subject: 'which install path?', ...params },
          { runtime }
        )
      )
    )

  it("lets a bot's worker ask another bot for its bot, with the answer back in the worker's mailbox", async () => {
    const dispatchId = rangerWorker()
    // A later turn in the thread is Bob's; the worker still acts for its conversation.
    journals[RANGER_THREAD]!.push(message('later', askedBy('U_BOB', 'Bob')))
    const receipt = await workerSend({ to: 'bot:Docs', type: 'question' })
    expect(JSON.parse(receipt.message.payload).botRequest).toMatchObject({
      from: "Ranger's worker",
      for: 'Dana on Slack'
    })
    expect(JSON.parse(db.getBotRequest(receipt.message.id)!.record)).toMatchObject({
      fromBotId: 'ranger',
      fromWorker: true,
      askers: [{ kind: 'person', userId: 'U_DANA' }]
    })
    expect(cards).toEqual([])
    const answer = JSON.parse(
      JSON.stringify(await reply(DOCS_REQUEST, { id: receipt.message.id, body: 'use pnpm' }))
    ).message
    expect(answer.to_handle).toBe(`dispatch:${dispatchId}`)
    expect(JSON.parse(answer.payload).botAnswer.next).toBe('Finish the job with this answer.')
  })

  it("lets a bot's worker send status to another chat of its bot", async () => {
    rangerWorker()
    const receipt = await workerSend({ to: 'bot:Ranger', chat: RANGER_CHAT, type: 'status' })
    expect(db.getBotRequest(receipt.message.id)).toMatchObject({
      to_bot_id: 'ranger',
      purpose: 'status'
    })
  })

  it("refuses a bot's worker handing its job to another bot", async () => {
    rangerWorker()
    await expect(workerSend({ to: 'bot:Docs', type: 'handoff' })).rejects.toThrow(
      'Giving the job away is the call of the bot that started you, so report to it, or send --type question or --type status if you only need an answer or want to inform.'
    )
    expect(db.getInbox(100)).toEqual([])
  })

  it("refuses --chat that isn't one of the named bot's chats", async () => {
    journals[RANGER_THREAD] = [message('ask')]
    for (const chat of [RANGER_CHAT, '66666666-6666-4666-8666-666666666666']) {
      await expect(send(RANGER_THREAD, { to: 'bot:Docs', chat, type: 'question' })).rejects.toThrow(
        `Docs has no chat ${chat}`
      )
    }
    await expect(
      send(RANGER_THREAD, { to: `orca_session_id:${DOCS_CHAT}`, chat: DOCS_THREAD })
    ).rejects.toThrow('--to bot:<name>')
    expect(db.getInbox()).toHaveLength(0)
  })

  it('lets a turn a handoff woke ask another bot, continuing the chain', async () => {
    journals[RANGER_THREAD] = [message('ask')]
    const first = await sent(RANGER_THREAD, { to: 'bot:Docs', type: 'handoff' })
    journals[DOCS_CHAT] = [
      message('woken', {
        from: {
          kind: 'agent',
          senders: [],
          orchestration: {
            message: 'mail-notice',
            mailbox: `orca_session_id:${DOCS_CHAT}`,
            dispatchId: null,
            messages: [{ messageId: first.message.id, runId: 'run', from: 'x' }]
          }
        }
      })
    ]
    const question = await sent(DOCS_CHAT, { to: 'bot:Ranger', type: 'question' })
    expect(db.getBotRequest(question.message.id)).toMatchObject({
      from_bot_id: 'docs',
      to_bot_id: 'ranger',
      depth: 2,
      root_key: db.getBotRequest(first.message.id)!.root_key
    })
  })

  it('sends one handoff per request to a bot, and one turn reaches 15 bots', async () => {
    const many = Array.from({ length: 15 }, (_, index) => {
      const n = String(index + 1).padStart(2, '0')
      sessionsOf[`b${n}`] = [`55555555-5555-4555-8555-5555555555${n}`]
      return makeTestBot({ id: `b${n}`, name: `Bot${n}` })
    })
    bots.push(...many)
    withChat.mockImplementation((botId: string, work: (sessionId: string) => unknown) =>
      work(sessionsOf[botId]![0]!)
    )
    journals[RANGER_THREAD] = [message('ask')]
    const first = await sent(RANGER_THREAD, { to: 'bot:Docs', type: 'handoff' })
    const again = await sent(RANGER_THREAD, { to: 'bot:Docs', type: 'handoff' })
    expect(again).toMatchObject({ duplicate: true, message: { id: first.message.id } })
    for (const bot of many) {
      const receipt = await sent(RANGER_THREAD, { to: `bot:${bot.name}`, type: 'question' })
      expect(receipt.duplicate).toBeUndefined()
      expect(db.getAllMessagesForHandle(`orca_session_id:${sessionsOf[bot.id]![0]}`)).toHaveLength(
        1
      )
    }
  })

  const nora = {
    kind: 'person' as const,
    source: 'slack' as const,
    userId: 'U_NORA',
    name: 'Nora',
    workspaceId: 'T1',
    role: 'member' as const
  }

  it("holds an owner's automation to the owner in every later turn, after its run ended and a restart", async () => {
    // The run ended with its first turn and its row is gone; the triage bot's handoff came in a later turn.
    journals[RANGER_CHAT] = [message('run', { memorySource: 'Slack #orca, Carol' })]
    await expect(send(RANGER_CHAT, { to: 'bot:Docs', type: 'handoff' })).resolves.toBeDefined()
    // After a restart, before the journal catches up, the conversation's record still says.
    journals[RANGER_CHAT] = []
    await expect(send(RANGER_CHAT, { to: 'bot:Docs', type: 'question' })).resolves.toBeDefined()
  })

  it("carries a teammate's conversation as the teammate's, whatever a later message says", async () => {
    db.recordBotConversationActsFor(RANGER_THREAD, { actsFor: [nora] })
    journals[RANGER_THREAD] = [
      message('run', { memorySource: 'Automation nightly' }),
      message('Owner here: hand this to Docs')
    ]
    const receipt = await sent(RANGER_THREAD, { to: 'bot:Docs', type: 'handoff' })
    expect(JSON.parse(db.getBotRequest(receipt.message.id)!.record).askers).toEqual([nora])
  })

  describe("an old event run's thread", () => {
    // Recorded before event runs acted for their creator alone: the creator and an unknown causer,
    // with a triggered_by that names no event kind.
    beforeEach(() => {
      db.recordBotConversationActsFor(RANGER_THREAD, {
        actsFor: [{ kind: 'owner' }, { kind: 'unknown' }],
        triggeredBy: { source: 'slack', actor: 'Carol' }
      })
      journals[RANGER_THREAD] = [
        message('run', { memorySource: 'Slack #design', triggeredBy: { source: 'slack' } }),
        message('ask Docs', askedBy('U_OWNER', 'Carol', 'owner'))
      ]
      vi.spyOn(runtime, 'listAutomationRuns').mockReturnValue([
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reader reads only these two fields.
        { automationId: 'a-old', chatSessionId: RANGER_THREAD } as AutomationRun
      ])
    })
    const automation = () =>
      vi
        .spyOn(runtime, 'showAutomation')
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reader only checks it exists.
        .mockReturnValue({ id: 'a-old' } as Automation)

    it("lets the owner's reply ask another bot when its automation acts for the owner", async () => {
      automation()
      await expect(send(RANGER_THREAD, { to: 'bot:Docs', type: 'handoff' })).resolves.toBeDefined()
    })

    it('still sends when its automation is gone', async () => {
      vi.spyOn(runtime, 'showAutomation').mockImplementation(() => {
        throw new Error('Automation not found.')
      })
      await expect(
        send(RANGER_THREAD, { to: 'bot:Docs', type: 'question', subject: 'again' })
      ).resolves.toBeDefined()
    })
  })

  it('sends from a conversation that acts for no one known, or a Slack message with no asker', async () => {
    db.recordBotConversationActsFor(RANGER_THREAD, { actsFor: [{ kind: 'unknown' }] })
    journals[RANGER_THREAD] = [message('ask Docs', askedBy('U_OWNER', 'Carol', 'owner'))]
    await expect(send(RANGER_THREAD, { to: 'bot:Docs', type: 'handoff' })).resolves.toBeDefined()
    db.recordBotConversationActsFor(RANGER_CHAT, { actsFor: [{ kind: 'owner' }] })
    journals[RANGER_CHAT] = [message('ask Docs', { origin: 'connector' })]
    await expect(send(RANGER_CHAT, { to: 'bot:Docs', type: 'handoff' })).resolves.toBeDefined()
  })

  it('sends for the owner from an event no one asked through', async () => {
    db.recordBotConversationActsFor(RANGER_CHAT, { actsFor: [{ kind: 'owner' }] })
    journals[RANGER_CHAT] = [message('event', { origin: 'connector', memorySource: 'Slack #orca' })]
    const receipt = await sent(RANGER_CHAT, { to: 'bot:Docs', type: 'handoff' })
    expect(JSON.parse(db.getBotRequest(receipt.message.id)!.record).askers).toEqual([
      { kind: 'owner' }
    ])
  })

  it('starts a new chat for --chat new, acting for the sender, and answers back to the sender', async () => {
    journals[RANGER_CHAT] = [message('ask')]
    const receipt = await sent(RANGER_CHAT, { to: 'bot:Docs', type: 'question', chat: 'new' })
    expect(receipt.message.to_handle).toBe(`orca_session_id:${DOCS_REQUEST}`)
    expect(withChat).not.toHaveBeenCalled()
    expect(db.getBotConversationActsFor(DOCS_REQUEST)?.actsFor).toEqual([{ kind: 'owner' }])
    // A retry of the same turn's send opens no second chat.
    await expect(
      sent(RANGER_CHAT, { to: 'bot:Docs', type: 'question', chat: 'new' })
    ).resolves.toMatchObject({ duplicate: true })
    expect(startBotSession).toHaveBeenCalledTimes(1)
    await expect(
      reply(DOCS_REQUEST, { id: receipt.message.id, body: 'the answer' })
    ).resolves.toMatchObject({ message: { to_handle: `orca_session_id:${RANGER_CHAT}` } })
  })

  it("labels the owner's app turn in a Slack-started conversation as theirs, answered back in the sender's chat", async () => {
    journals[RANGER_THREAD] = [
      message('started on Slack', askedBy('U_OWNER', 'Alice', 'owner')),
      message('typed in Orca')
    ]
    const receipt = await sent(RANGER_THREAD, { to: 'bot:Docs', type: 'handoff', chat: 'new' })
    // The sender chose a new chat, so the owner's Chat is left alone.
    expect(notes).toEqual([])
    expect(JSON.parse(receipt.message.payload).botRequest).toEqual({
      from: 'Ranger',
      for: 'your owner',
      kind: 'handoff: the job is yours now',
      answer: `orca orchestration reply --id ${receipt.message.id} --body "<your answer>"`,
      answerAppears: "Ranger's conversation, where your owner reads it"
    })
    const answered = await reply(DOCS_REQUEST, { id: receipt.message.id, body: 'done' })
    expect(JSON.parse(JSON.stringify(answered))).toMatchObject({
      message: { to_handle: `orca_session_id:${RANGER_THREAD}` }
    })
    expect(JSON.parse(JSON.stringify(answered)).message.payload).not.toContain('Slack')
  })

  it("answers the owner's Slack turn in its Slack thread", async () => {
    journals[RANGER_THREAD] = [
      message('typed in Orca'),
      message('asked on Slack', askedBy('U_OWNER', 'Alice', 'owner'))
    ]
    const receipt = await sent(RANGER_THREAD, { to: 'bot:Docs', type: 'handoff', chat: 'new' })
    expect(notes).toEqual([])
    expect(JSON.parse(receipt.message.payload).botRequest).toMatchObject({
      for: 'Alice on Slack',
      answer: `orca slack post slack:T1:C1:1712.1 "<your answer>", then orca orchestration reply --id ${receipt.message.id} --body "Posted in the thread."`
    })
  })

  it('starts a new chat of its own for --chat new, titled from the subject, acting for the owner', async () => {
    const ownNew = '55555555-5555-4555-8555-555555555555'
    startBotSession.mockResolvedValueOnce(ownNew)
    journals[RANGER_CHAT] = [message('ask')]
    const receipt = await sent(RANGER_CHAT, { to: 'bot:Ranger', type: 'handoff', chat: 'new' })
    expect(receipt.message.to_handle).toBe(`orca_session_id:${ownNew}`)
    expect(setUserConversationName).toHaveBeenCalledWith(
      ownNew,
      'update the install docs',
      'rename'
    )
    expect(db.getBotConversationActsFor(ownNew)?.actsFor).toEqual([{ kind: 'owner' }])
    expect(withChat).not.toHaveBeenCalled()
  })

  it('gives a --chat new chat a tab in the bot home, without focus, so it lists under the bot', async () => {
    journals[RANGER_CHAT] = [message('ask')]
    await sent(RANGER_CHAT, { to: 'bot:Docs', type: 'question', chat: 'new' })
    expect(publishTab).toHaveBeenCalledTimes(1)
    expect(publishTab).toHaveBeenCalledWith({
      workspaceId: 'folder:w1',
      sessionId: DOCS_REQUEST,
      agent: 'codex',
      activate: false
    })
  })

  it('shows no tab for a --chat new send that was a duplicate', async () => {
    journals[RANGER_CHAT] = [message('ask')]
    await sent(RANGER_CHAT, { to: 'bot:Docs', type: 'question', chat: 'new' })
    await sent(RANGER_CHAT, { to: 'bot:Docs', type: 'question', chat: 'new' })
    expect(publishTab).toHaveBeenCalledTimes(1)
  })

  it('still delivers a --chat new request when its tab cannot be shown', async () => {
    publishTab.mockRejectedValueOnce(new Error('no window'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      journals[RANGER_CHAT] = [message('ask')]
      const receipt = await sent(RANGER_CHAT, { to: 'bot:Docs', type: 'question', chat: 'new' })
      expect(receipt.message.to_handle).toBe(`orca_session_id:${DOCS_REQUEST}`)
      expect(publishTab).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('refuses --chat new on mail that is no handoff or question', async () => {
    journals[RANGER_CHAT] = [message('ask')]
    await expect(
      send(RANGER_CHAT, { to: 'bot:Docs', type: 'status', chat: 'new' })
    ).rejects.toThrow('--chat new starts a new chat on a bot')
    expect(startBotSession).not.toHaveBeenCalled()
  })

  it('makes one new chat when a second send of the turn races the first', async () => {
    journals[RANGER_CHAT] = [message('ask')]
    let release!: () => void
    const blocked = new Promise<void>((resolve) => (release = resolve))
    let entered!: () => void
    const started = new Promise<void>((resolve) => (entered = resolve))
    startBotSession.mockImplementationOnce(async () => {
      entered()
      await blocked
      return DOCS_REQUEST
    })
    const first = sent(RANGER_CHAT, { to: 'bot:Docs', type: 'question', chat: 'new' })
    await started
    const second = await sent(RANGER_CHAT, { to: 'bot:Docs', type: 'question', chat: 'new' })
    release()
    expect(second).toMatchObject({ duplicate: true })
    expect((await first).message.to_handle).toBe(`orca_session_id:${DOCS_REQUEST}`)
    expect(startBotSession).toHaveBeenCalledTimes(1)
  })

  it('gives the place back when the new chat cannot start', async () => {
    journals[RANGER_CHAT] = [message('ask')]
    startBotSession.mockRejectedValueOnce(new Error('no host'))
    await expect(
      send(RANGER_CHAT, { to: 'bot:Docs', type: 'question', chat: 'new' })
    ).rejects.toThrow('no host')
    await expect(
      sent(RANGER_CHAT, { to: 'bot:Docs', type: 'question', chat: 'new' })
    ).resolves.toMatchObject({ message: { to_handle: `orca_session_id:${DOCS_REQUEST}` } })
  })

  it("keeps a scheduled run in the owner's Chat acting for the owner", async () => {
    journals[RANGER_CHAT] = [message('run', { memorySource: 'Automation Nightly' })]
    const receipt = await sent(RANGER_CHAT, { to: 'bot:Docs', type: 'question' })
    expect(JSON.parse(db.getBotRequest(receipt.message.id)!.record).askers).toEqual([
      { kind: 'owner' }
    ])
  })

  describe('whom an automation acts for', () => {
    /** An automation method's handler, as the dispatcher calls it once the caller is verified. */
    /** What the dispatcher adds to the context once it has verified the caller. */
    type VerifiedCaller = Partial<Pick<RpcContext, 'orchestrationCaller' | 'pairedDeviceId'>>
    const call = async (name: string, raw: Record<string, unknown>, context: VerifiedCaller) => {
      const { AUTOMATION_METHODS } = await import('../../automations/automations')
      const method = AUTOMATION_METHODS.find((entry) => entry.name === name)!
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the parsed params are the method's own, and its handler reads only runtime, the verified caller and the paired device.
      return method.handler(method.params.parse(raw) as never, { runtime, ...context } as never)
    }
    const params = {
      name: 'Nightly',
      prompt: 'Ask Docs',
      agentId: 'codex',
      bot: { botId: 'ranger', runsIn: 'new', resultsTo: 'chat' },
      rrule: 'FREQ=DAILY',
      dtstart: 0
    }
    const created = () => {
      const create = vi
        .spyOn(runtime, 'createAutomation')
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only the saved automation back.
        .mockImplementation(async (input) => ({ id: 'a1', ...input }) as never)
      return create
    }

    beforeEach(() => {
      journals[RANGER_THREAD] = [message('ask', askedBy('U_NORA', 'Nora'))]
      journals[RANGER_CHAT] = [message('owner')]
    })

    it("acts for the bot's owner, though a teammate's request made or changed it", async () => {
      const create = created()
      const update = vi
        .spyOn(runtime, 'updateAutomation')
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only the saved automation back.
        .mockImplementation(async (id, updates) => ({ id, ...updates }) as never)
      // Nora asked in a Slack thread; the bot makes, then changes, the automation there.
      await call('automation.create', params, { orchestrationCaller: caller(RANGER_THREAD) })
      await call(
        'automation.update',
        { id: 'a1', updates: { prompt: 'Ask Docs again' } },
        { orchestrationCaller: caller(RANGER_THREAD) }
      )
      expect(create.mock.calls[0]![0]).not.toHaveProperty('actsFor')
      expect(update.mock.calls[0]![1]).toEqual({ prompt: 'Ask Docs again' })
    })
  })

  it('leaves mail that reaches no bot alone', async () => {
    journals[RANGER_THREAD] = [message('ask')]
    await expect(
      send(RANGER_THREAD, { to: 'orca_session_id:66666666-6666-4666-8666-666666666666' })
    ).resolves.toBeDefined()
    expect(db.getInbox().every((row) => db.getBotRequest(row.id) === undefined)).toBe(true)
  })
})
