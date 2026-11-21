import '../../../dispatch/testing/unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../../../shared/bot-types'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import { replyFollowUp } from './reply-follow-up'
import type * as RecipientRouting from './recipient-routing'
import {
  askedBy,
  caller,
  DOCS_CHAT,
  journals,
  message,
  RANGER_CHAT,
  RANGER_THREAD,
  setupBotMail
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

describe('mail to a bot, by the ways around its checks', () => {
  const h = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let bots: Bot[]
  let send: ReturnType<typeof setupBotMail>['send']
  let sent: ReturnType<typeof setupBotMail>['sent']
  let reply: ReturnType<typeof setupBotMail>['reply']

  beforeEach(() => {
    ;({ db, runtime, bots, send, sent, reply } = setupBotMail(h))
  })
  afterEach(() => h.cleanup())

  it("holds an outsider's mail to a Run a bot coordinates to that bot's checks", async () => {
    const run = db.createRun({
      objective: 'docs work',
      coordinatorHandle: null,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: caller(DOCS_CHAT).orcaSessionId
    })
    journals[RANGER_THREAD] = [message('ask', askedBy('U_NORA', 'Nora'))]
    bots[1] = { ...bots[1]!, paused: true }
    await expect(
      send(RANGER_THREAD, { to: `run:${run.id}`, type: 'handoff', run: run.id })
    ).rejects.toThrow('Docs is paused')
  })

  it('lets only the bot a request went to answer it', async () => {
    journals[RANGER_THREAD] = [message('ask')]
    const request = await sent(RANGER_THREAD, { to: 'bot:Docs', type: 'question' })
    await expect(
      reply(RANGER_CHAT, { id: request.message.id, body: 'forged answer' })
    ).rejects.toThrow("That message wasn't sent to you")
    await expect(
      reply(DOCS_CHAT, { id: request.message.id, body: 'the answer' })
    ).resolves.toMatchObject({ message: { to_handle: `orca_session_id:${RANGER_THREAD}` } })
  })

  it("hints the send that reaches a bot's chat where reply refuses, and that send goes through", async () => {
    const original = db.insertMessage({
      from: `orca_session_id:${DOCS_CHAT}`,
      to: 'term_someone',
      subject: 'status'
    })
    const reader = { party: caller(RANGER_CHAT), sessionId: RANGER_CHAT }
    expect(replyFollowUp(runtime, db, original, reader)).toEqual({
      kind: 'mail_sender',
      to: 'bot:Docs',
      chat: DOCS_CHAT
    })
    await expect(reply(RANGER_CHAT, { id: original.id, body: 'hi' })).rejects.toMatchObject({
      code: 'bot_reply_not_yours',
      message: expect.stringContaining(
        `orca orchestration send --to bot:Docs --chat ${DOCS_CHAT} --type question`
      )
    })
    journals[RANGER_CHAT] = [message('ask')]
    await expect(
      send(RANGER_CHAT, { to: 'bot:Docs', chat: DOCS_CHAT, type: 'question' })
    ).resolves.toMatchObject({ message: { to_handle: `orca_session_id:${DOCS_CHAT}` } })
  })

  it("keeps the reply hint on a bot's mail for the party it was sent to", async () => {
    const direct = db.insertMessage({
      from: `orca_session_id:${DOCS_CHAT}`,
      to: `orca_session_id:${RANGER_THREAD}`,
      subject: 'answer'
    })
    const reader = { party: caller(RANGER_THREAD), sessionId: RANGER_THREAD }
    expect(replyFollowUp(runtime, db, direct, reader)).toBeUndefined()
  })

  it('gives an owner chat one request per message, with the same cap', async () => {
    journals['55555555-5555-4555-8555-555555555555'] = [message('owner ask')]
    const first = await sent('55555555-5555-4555-8555-555555555555', {
      to: 'bot:Docs',
      type: 'handoff'
    })
    const again = await sent('55555555-5555-4555-8555-555555555555', {
      to: 'bot:Docs',
      type: 'handoff'
    })
    expect(again).toMatchObject({ duplicate: true, message: { id: first.message.id } })
    expect(vi.mocked(runtime.notifyMessageArrived)).toHaveBeenCalledTimes(1)
  })
})
