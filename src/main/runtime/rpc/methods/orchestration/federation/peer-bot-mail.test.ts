import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ORCHESTRATION_CONTRACT_VERSION,
  ORCHESTRATION_PEER_BOT_MAIL_RUNTIME_CAPABILITY,
  ORCHESTRATION_PEER_MAIL_FILES_RUNTIME_CAPABILITY
} from '../../../../../../shared/orchestration/orchestration-runtime-capabilities'
import type { RuntimeRpcResponse } from '../../../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { readAnswerSenderSnapshot } from '../../../../../../shared/agent-session/journal/answer-sender-snapshot'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { OrchestrationEnvironmentTransport } from '../../../../orchestration/federation/environment-transport'
import type { OrchestrationSessionCaller } from '../../../../orchestration/addressing/orchestration-caller-identity'
import { RpcDispatcher } from '../../../dispatcher'
import type { RpcContext } from '../../../core'
import { ORCHESTRATION_METHODS } from '../orchestration'
import { ORCHESTRATION_REPLY_METHOD } from '../messaging/reply-method'
import { dropUnreadBotRequests } from '../messaging/bot-request-outcome'
import { makeTestBot } from '../../../../../bots/bot.test-fixture'
import type * as RecipientRouting from '../messaging/recipient-routing'
import {
  DOCS_CHAT,
  DOCS_THREAD,
  RANGER_THREAD,
  withChat
} from '../messaging/bot-recipient.test-fixture'

vi.mock(
  '../../../../orchestration/federation/relay/federation-relay-scheduler',
  async (original) => ({
    ...(await original<object>()),
    federationRelayRetryDelayMs: () => 0
  })
)
vi.mock(
  '../../../../../bots/bot-session-tabs',
  async () => (await import('../messaging/bot-recipient.test-fixture')).botSessionTabsMock
)
vi.mock(
  '../../../../../bots/bot-chat-session',
  async () => (await import('../messaging/bot-recipient.test-fixture')).botChatSessionMock
)
vi.mock(
  '../../../../../bots/bot-chat-mail-hold',
  async () => (await import('../messaging/bot-recipient.test-fixture')).botChatMailHoldMock
)
vi.mock(
  '../../../../../bots/bot-chat-status-line',
  async () => (await import('../messaging/bot-recipient.test-fixture')).botChatStatusLineMock
)
vi.mock('../messaging/recipient-routing', async (importOriginal) =>
  (await import('../messaging/bot-recipient.test-fixture')).recipientRoutingMock(
    await importOriginal<typeof RecipientRouting>()
  )
)

// Ranger's chat on A asks Docs, a bot on B.
const ASKER = `orca_session_id:${RANGER_THREAD}`
const DOCS_HOME = `orca_session_id:${DOCS_CHAT}`

type Side = { db: OrchestrationDb; runtime: OrcaRuntimeService; dispatcher: RpcDispatcher }

function sessionCaller(address: string): OrchestrationSessionCaller {
  const id = address.slice('orca_session_id:'.length)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixed UUID test ids are Orca session ids.
  return {
    address,
    terminalHandle: null,
    paneKey: null,
    orcaSessionId: id,
    sessionId: id,
    workspaceId: 'w'
  } as OrchestrationSessionCaller
}

describe('mail to a bot on a paired server', () => {
  let dir: string
  let a: Side
  let b: Side
  let bCapabilities: (capabilities: string[]) => string[]

  function openSide(
    name: string,
    machine: string,
    bots: ReturnType<typeof makeTestBot>[],
    transport?: OrchestrationEnvironmentTransport
  ): Side {
    const db = new OrchestrationDb(join(dir, `${name}.db`))
    const runtime = new OrcaRuntimeService(null, undefined, {
      orchestrationEnvironmentTransport: transport
    })
    vi.spyOn(runtime, 'readMachineName').mockReturnValue(machine)
    vi.spyOn(runtime, 'getTerminalHandleForPaneKey').mockReturnValue(null)
    vi.spyOn(runtime.bots, 'list').mockReturnValue(bots)
    vi.spyOn(runtime.bots, 'enabled').mockReturnValue(true)
    vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue(undefined)
    vi.spyOn(runtime, 'listAutomationRuns').mockReturnValue([])
    runtime.setOrchestrationDb(db)
    return {
      db,
      runtime,
      dispatcher: new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
    }
  }

  const transport: OrchestrationEnvironmentTransport = {
    resolve: () => ({
      environmentId: 'env_b',
      name: 'devB',
      peerFingerprint: 'fingerprint_b',
      homePeerFingerprint: 'fingerprint_a'
    }),
    hasEnvironment: () => true,
    call: async (_selector, method, params) => {
      if (method === 'status.get') {
        const status = b.runtime.getStatus()
        return {
          id: 'status',
          ok: true,
          result: { ...status, capabilities: bCapabilities(status.capabilities ?? []) },
          _meta: { runtimeId: b.runtime.getRuntimeId() }
        }
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double carrying only the fields the code under test reads.
      return (await b.dispatcher.dispatch(
        {
          id: `from_a_${method}`,
          authToken: 'a-device-token',
          method,
          params,
          orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION
        },
        {
          authenticatedCallerFingerprint: 'fingerprint_a',
          pairedDeviceId: 'device_a',
          clientKind: 'runtime'
        }
      )) as RuntimeRpcResponse<unknown>
    }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-peer-bot-mail-'))
    bCapabilities = (capabilities) => capabilities
    withChat.mockReset()
    withChat.mockImplementation((_botId, work) => work(DOCS_CHAT))
    b = openSide('b', 'Build Box', [makeTestBot({ id: 'docs', name: 'Docs' })])
    a = openSide(
      'a',
      "Alice's Mac",
      [makeTestBot({ id: 'ranger', name: 'Ranger', avatar: 'mascot:A1' })],
      transport
    )
  })

  afterEach(() => {
    a.runtime.stopOrchestrationFederationRelay()
    b.runtime.stopOrchestrationFederationRelay()
    a.db.close()
    b.db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function send(params: Record<string, unknown>) {
    const method = ORCHESTRATION_METHODS.find((entry) => entry.name === 'orchestration.send')!
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double carrying only the fields the code under test reads.
    const context = { runtime: a.runtime, orchestrationCaller: sessionCaller(ASKER) } as RpcContext
    return method.handler(
      {
        from: ASKER,
        on: 'devB',
        to: 'bot:Docs',
        subject: 'Where is the install guide?',
        ...params
      },
      context
    )
  }

  function botReply(id: string, body: string) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double carrying only the fields the code under test reads.
    return ORCHESTRATION_REPLY_METHOD.handler({ id, body }, {
      runtime: b.runtime,
      orchestrationCaller: sessionCaller(DOCS_HOME)
    } as RpcContext)
  }

  async function pulledByAsker() {
    a.runtime.ensureOrchestrationFederationRelay()
    await vi.waitFor(() => expect(a.db.getUnreadMessages(ASKER)).toHaveLength(1))
    return a.db.getUnreadMessages(ASKER)[0]!
  }

  it("admits a question as the owner's bot request and brings its answer back as an answer", async () => {
    await send({ type: 'question' })

    const [request] = b.db.getUnreadMessages(DOCS_HOME)
    expect(request).toMatchObject({ type: 'question', from_handle: `${ASKER} on Alice's Mac` })
    expect(b.db.getBotRequest(request!.id)).toMatchObject({ to_bot_id: 'docs', from_bot_id: null })
    expect(withChat).toHaveBeenCalledWith('docs', expect.any(Function))
    expect(readAnswerSenderSnapshot(request!.answer_sender_snapshot)).toMatchObject({
      name: 'Ranger',
      bot: true,
      botAvatar: 'mascot:A1',
      host: "Alice's Mac"
    })

    await botReply(request!.id, 'docs/install.md')
    const answer = await pulledByAsker()
    expect(answer).toMatchObject({ body: 'docs/install.md', thread_id: request!.id })
    expect(JSON.parse(answer.payload!)).toMatchObject({
      requestId: request!.id,
      botAnswer: { from: 'Docs', answers: 'your question' }
    })
    expect(readAnswerSenderSnapshot(answer.answer_sender_snapshot)).toMatchObject({
      name: 'Docs',
      bot: true,
      host: 'Build Box'
    })
    await expect(botReply(request!.id, 'again')).rejects.toThrow('already answered')
  })

  it('hands work to a bot with no Home Chat yet, and refuses to answer status', async () => {
    await send({ type: 'handoff', subject: 'Take the docs task' })
    await send({ type: 'status', subject: 'FYI: docs merged' })

    const mail = b.db.getUnreadMessages(DOCS_HOME)
    expect(mail.map((message) => [message.type, message.subject])).toEqual([
      ['handoff', 'Take the docs task'],
      ['status', 'FYI: docs merged']
    ])
    await expect(botReply(mail[1]!.id, 'ok')).rejects.toThrow('nothing to answer')
  })

  it("lands --chat in that chat, and refuses a chat that isn't the bot's with nothing stored", async () => {
    await send({ type: 'question', chat: `chat:${DOCS_THREAD}` })
    expect(b.db.getUnreadMessages(`orca_session_id:${DOCS_THREAD}`)).toHaveLength(1)
    expect(withChat).not.toHaveBeenCalled()

    await expect(send({ type: 'question', chat: RANGER_THREAD })).rejects.toThrow(
      `Docs has no chat ${RANGER_THREAD}`
    )
    expect(b.db.getInbox(10)).toHaveLength(1)
  })

  it('tells the asker over the conversation when the bot drops the request unread', async () => {
    await send({ type: 'question' })
    await dropUnreadBotRequests(b.runtime, 'docs', 'paused')

    const notice = await pulledByAsker()
    expect(notice.subject).toBe('Re: Where is the install guide?')
    expect(readAnswerSenderSnapshot(notice.answer_sender_snapshot)).toMatchObject({
      party: { address: `${DOCS_HOME} on Build Box` },
      name: 'Docs',
      host: 'Build Box'
    })
  })

  it('admits a retried delivery once, and takes an older peer’s mail without a sender', async () => {
    const deliver = {
      conversationId: 'peerconv_aaaaaaaaaaaa',
      messageId: 'msg_aaaaaaaaaaaa',
      to: 'bot:Docs',
      senderLabel: "term_a on Alice's Mac",
      subject: 'Once',
      type: 'handoff'
    }
    const first = await transport.call('devB', 'orchestration.peerMailDeliver', deliver)
    const retried = await transport.call('devB', 'orchestration.peerMailDeliver', deliver)

    expect(first).toMatchObject({ ok: true })
    expect(retried).toMatchObject({ ok: true, result: { message: { id: 'msg_aaaaaaaaaaaa' } } })
    const [stored] = b.db.getUnreadMessages(DOCS_HOME)
    expect(b.db.getUnreadMessages(DOCS_HOME)).toHaveLength(1)
    expect(stored).toMatchObject({ id: 'msg_aaaaaaaaaaaa', answer_sender_snapshot: null })
    expect(b.db.getBotRequest('msg_aaaaaaaaaaaa')).toBeDefined()
  })

  it('refuses a retry while the first delivery is still being admitted, so it is never lost', async () => {
    const deliver = {
      conversationId: 'peerconv_bbbbbbbbbbbb',
      messageId: 'msg_bbbbbbbbbbbb',
      to: 'bot:Docs',
      senderLabel: "term_a on Alice's Mac",
      subject: 'Slow',
      type: 'handoff'
    }
    // The first attempt waits for the Home Chat, then fails.
    let fail: () => void = () => {}
    withChat.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = () => reject(new Error('chat host went away'))
        })
    )
    const first = transport.call('devB', 'orchestration.peerMailDeliver', deliver)
    await vi.waitFor(() => expect(withChat).toHaveBeenCalled())

    const retried = await transport.call('devB', 'orchestration.peerMailDeliver', deliver)
    expect(retried).toMatchObject({
      ok: false,
      error: { code: 'delivery_in_progress', data: { effectsApplied: false } }
    })
    fail()
    await expect(first).resolves.toMatchObject({ ok: false })
    expect(b.db.getInbox(10)).toEqual([])

    // The sender's next retry admits it.
    await expect(
      transport.call('devB', 'orchestration.peerMailDeliver', deliver)
    ).resolves.toMatchObject({ ok: true })
    expect(b.db.getUnreadMessages(DOCS_HOME)).toHaveLength(1)
  })

  it('re-admits nothing after a restart left a stored request unlinked, and still routes its reply', async () => {
    const deliver = {
      conversationId: 'peerconv_ffffffffffff',
      messageId: 'msg_ffffffffffff',
      to: 'bot:Docs',
      senderLabel: "term_a on Alice's Mac",
      subject: 'Crashed',
      type: 'handoff'
    }
    await transport.call('devB', 'orchestration.peerMailDeliver', deliver)
    // A restart between storing the request and filing it under its conversation.
    b.db.db.prepare('DELETE FROM peer_mail_messages WHERE message_id = ?').run(deliver.messageId)

    await expect(
      transport.call('devB', 'orchestration.peerMailDeliver', deliver)
    ).resolves.toMatchObject({ ok: true })
    expect(b.db.getUnreadMessages(DOCS_HOME)).toHaveLength(1)
    expect(b.db.getPeerMailMessage(deliver.messageId)?.conversation_id).toBe(deliver.conversationId)
  })

  it('delivers once after a restart left its request held with no mail', async () => {
    const deliver = {
      conversationId: 'peerconv_0a0a0a0a0a0a',
      messageId: 'msg_0a0a0a0a0a0a',
      to: 'bot:Docs',
      senderLabel: "term_a on Alice's Mac",
      subject: 'Orphaned',
      type: 'handoff'
    }
    // What a restart during the new chat's creation leaves: the request's place, no mail.
    b.db.reserveBotRequest({
      messageId: deliver.messageId,
      rootKey: 'send:orphan',
      fromBotId: null,
      toBotId: 'docs',
      purpose: 'handoff',
      depth: 0,
      record: '{}'
    })

    const retried = await transport.call('devB', 'orchestration.peerMailDeliver', deliver)
    expect(retried).toMatchObject({ ok: true })
    expect(b.db.getUnreadMessages(DOCS_HOME).map((message) => message.id)).toEqual([
      deliver.messageId
    ])
  })

  it('carries only an avatar the other computer can draw', async () => {
    const sender = (avatar: string) => ({
      name: null,
      computer: "Alice's Mac",
      bot: { id: 'ranger', name: 'Ranger', avatar }
    })
    for (const [id, avatar] of [
      ['msg_cccccccccccc', 'upload:3'],
      ['msg_dddddddddddd', '/Users/alice/.orca/bots/ranger/avatar.png'],
      ['msg_eeeeeeeeeeee', '🦊']
    ] as const) {
      await transport.call('devB', 'orchestration.peerMailDeliver', {
        conversationId: 'peerconv_cccccccccccc',
        messageId: id,
        to: 'bot:Docs',
        senderLabel: "orca_session_id:x on Alice's Mac",
        subject: id,
        type: 'status',
        sender: sender(avatar)
      })
    }
    expect(
      b.db
        .getUnreadMessages(DOCS_HOME)
        .map((message) => readAnswerSenderSnapshot(message.answer_sender_snapshot)?.botAvatar)
    ).toEqual([undefined, undefined, '🦊'])
  })

  it('refuses mail for a bot on a server too old to admit it, before sending anything', async () => {
    bCapabilities = (capabilities) =>
      capabilities.filter(
        (capability) => capability !== ORCHESTRATION_PEER_BOT_MAIL_RUNTIME_CAPABILITY
      )

    await expect(send({ type: 'question' })).rejects.toMatchObject({
      code: 'server_mail_unsupported'
    })
    expect(b.db.getInbox(10)).toEqual([])
  })

  it('sends the words without the files to a server too old to take them, and says so', async () => {
    bCapabilities = (capabilities) =>
      capabilities.filter(
        (capability) => capability !== ORCHESTRATION_PEER_MAIL_FILES_RUNTIME_CAPABILITY
      )
    const shot = join(dir, 'shot.png')
    writeFileSync(shot, Buffer.alloc(4))

    await expect(send({ type: 'question', files: [shot] })).resolves.toMatchObject({
      warnings: [
        {
          code: 'files_not_sent',
          message: "devB's Orca needs an update to receive files, so the message went without them."
        }
      ]
    })
    expect(b.db.getUnreadMessages(DOCS_HOME)).toMatchObject([{ type: 'question' }])
  })
})
