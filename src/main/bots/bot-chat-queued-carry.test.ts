import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { Bot } from '../../shared/bot-types'
import type { AgentJournalMessageItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentMessageSource } from '../../shared/agent-session/journal/agent-session-message-source'
import { readTestJournalItems } from '../native-chat/agent-session-journal/journal-observation.test-support'
import {
  createQueuedMessageTestRig,
  QUEUED_RIG_CALLER,
  type QueuedMessageTestRig
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import { QUEUED_MESSAGE_HELD_DELIVERY_UNCONFIRMED } from '../native-chat/agent-session-journal/queued-messages/queued-message-table'
import { replyEventsOf } from '../connector-cloud/connector-reply-outbox'
import { outcomeSentence } from '../connector-cloud/connector-reply-outcome-sentence'
import { botChatSessions } from './bot-chat-session'
import { carryQueuedMessages } from './bot-chat-queued-carry'
import { eventually } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig-provider.test-fixture'
import { NO_STRUCTURED_AGENTS } from '../native-chat/agent-session-wire/providers/testing/structured-agent-session-adapter-router.test-fixture'
import type { StructuredAgentRegistry } from '../native-chat/agent-session-wire/providers/structured-agent-registry'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-host'

/** The real host, reading agent declarations from `agents` where the move asks for them. */
function withAgents(
  host: StructuredAgentSessionHost,
  agents: StructuredAgentRegistry
): StructuredAgentSessionHost {
  const view: StructuredAgentSessionHost = Object.create(host)
  Object.defineProperty(view, 'deps', { value: { ...host.deps, agents } })
  return view
}

const party = { address: 'term_worker', terminalHandle: 'term_worker', orcaSessionId: null }
const RESULT_SENDER: AgentMessageSource = {
  kind: 'agent',
  senders: [{ party, name: 'nightly run' }],
  orchestration: null
}
const MAIL: AgentMessageSource = {
  kind: 'agent',
  senders: [{ party, name: 'another bot' }],
  orchestration: { message: 'mail-notice', mailbox: 'term_bot', dispatchId: null, messages: [] }
}
const IMAGE = { type: 'image-ref', path: '/private-fixture/shot.png' } as const
const DM_DELIVERY = {
  account: 'acct-1',
  conversation: { source: 'slack', externalId: 'D123' },
  deliveryId: 'delivery-1'
}

function textOf(body: AgentJournalMessageItem): string {
  return body.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')
}

describe('replacing a chat carries its unsent queued messages', () => {
  let rig: QueuedMessageTestRig | undefined
  afterEach(async () => {
    await rig?.dispose()
    rig = undefined
  })

  async function setup(
    createChat?: (sessionId: string) => Promise<void>,
    newChatAgent: 'codex' | 'claude' = 'codex',
    agents?: StructuredAgentRegistry
  ) {
    rig = await createQueuedMessageTestRig()
    const current = rig
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: replace reads only these fields.
    let bot = {
      id: 'bot-1',
      agent: 'codex',
      chatSessionId: HOST_TEST_SESSION,
      folderWorkspaceId: 'home'
    } as Bot
    const attach = async (sessionId: string) => {
      const attached = await current.host.attach(
        QUEUED_RIG_CALLER,
        hostTestAttachParams(null, {
          envelope: {
            sessionId,
            clientOperationId: hostTestOperationId(),
            expectedRuntimeFence: null,
            payloadFingerprint: ''
          },
          ...(newChatAgent === 'claude'
            ? ({
                provider: 'claude',
                agent: 'claude',
                providerHandle: { kind: 'claude', sessionId: randomUUID(), leafUuid: null },
                accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/private-fixture/claude' }
              } as const)
            : { providerHandle: { kind: 'codex', threadId: `thread-${sessionId}` } })
        })
      )
      expect(attached).toMatchObject({ ok: true })
    }
    const chats = botChatSessions({
      bots: {
        list: () => [bot],
        setChatSession: async (_id, sessionId) => {
          bot = { ...bot, chatSessionId: sessionId }
          return bot
        }
      },
      host: async () => (agents ? withAgents(current.host, agents) : current.host),
      createChat: async (_bot, sessionId) => (createChat ?? attach)(sessionId),
      showTab: async () => {},
      closeChat: async (sessionId) => {
        await current.host.close(sessionId, 'user-close')
        // Someone opens the closed chat from its history and starts editing a card.
        const { queuedMessages } = (await current.host.conversation(sessionId)).journal
        const editing = await queuedMessages.get('editing')
        await queuedMessages.editLeases.acquire(
          { callerKey: 'phone', editId: 'edit-1' },
          { messageId: 'editing', fingerprint: editing!.fingerprint }
        )
        return { stopped: true }
      },
      dropUnreadMail: async () => {}
    })
    await current.workingSend()
    expect(await current.send('owner text', 'queue-if-active').result).toMatchObject({ ok: true })
    const { queuedMessages } = (await current.host.conversation(HOST_TEST_SESSION)).journal
    const message = (text: string) => hostTestMessage(text)
    await queuedMessages.insert({
      messageId: 'result',
      body: { ...message('run result'), from: RESULT_SENDER },
      unattended: true
    })
    await queuedMessages.insert({ messageId: 'mail', body: { ...message('mail'), from: MAIL } })
    await queuedMessages.insert({
      messageId: 'image',
      body: { ...message('look at this'), blocks: [...message('look at this').blocks, IMAGE] }
    })
    await queuedMessages.insert({
      messageId: 'dm',
      body: { ...message('slack dm'), connectorDelivery: DM_DELIVERY },
      unattended: false
    })
    await queuedMessages.insert({
      messageId: 'unconfirmed',
      body: message('maybe sent'),
      holdReason: QUEUED_MESSAGE_HELD_DELIVERY_UNCONFIRMED
    })
    await queuedMessages.insert({
      messageId: 'plan',
      body: message('plan it first'),
      options: { interactionMode: 'plan', model: 'gpt-fixture', effort: 'high' },
      deliveryMode: 'steer'
    })
    await queuedMessages.insert({ messageId: 'editing', body: message('editing') })
    return { chats }
  }

  async function queuedTexts(sessionId: string) {
    const { journal } = await rig!.host.conversation(sessionId)
    return (await journal.queuedMessages.list())
      .filter((row) => row.state === 'waiting' || row.state === 'returned')
      .map((row) => row.body)
  }

  async function received(sessionId: string) {
    const { journal } = await rig!.host.conversation(sessionId)
    const sent = (await readTestJournalItems(journal)).flatMap(({ body }) =>
      body.kind === 'message' && body.role === 'user' ? [body] : []
    )
    return [...sent, ...(await queuedTexts(sessionId))]
  }

  it('moves them, in order with sender and images, out of the old chat', async () => {
    const { chats } = await setup()
    const next = await chats.reset('bot-1')
    expect(next).not.toBe(HOST_TEST_SESSION)
    const bodies = await received(next)
    expect(bodies.map(textOf)).toEqual([
      'owner text',
      'run result',
      'look at this',
      'maybe sent',
      'plan it first'
    ])
    expect(bodies[0].from).toBeUndefined()
    expect(bodies[1].from).toEqual(RESULT_SENDER)
    expect(bodies[2].blocks).toContainEqual(IMAGE)
    // Orchestration mail stays with the old chat's mailbox; a card being edited stays with its editor.
    expect((await queuedTexts(HOST_TEST_SESSION)).map(textOf)).toEqual(['mail', 'editing'])
  })

  it('says a card stayed while it is being edited, and moves it once the edit ends', async () => {
    const { chats } = await setup()
    const next = await chats.reset('bot-1')
    const { queuedMessages } = (await rig!.host.conversation(HOST_TEST_SESSION)).journal
    await expect(carryQueuedMessages(rig!.host, HOST_TEST_SESSION, next)).resolves.toBe(false)
    await queuedMessages.editLeases.release({ callerKey: 'phone', editId: 'edit-1' }, 'editing')
    await expect(carryQueuedMessages(rig!.host, HOST_TEST_SESSION, next)).resolves.toBe(true)
    expect((await queuedTexts(next)).map(textOf)).toContain('editing')
    expect((await queuedTexts(HOST_TEST_SESSION)).map(textOf)).toEqual(['mail'])
  })

  it('tells a queued direct message it stopped instead of moving it', async () => {
    const { chats } = await setup()
    const next = await chats.reset('bot-1')
    expect((await received(next)).map(textOf)).not.toContain('slack dm')
    expect((await queuedTexts(HOST_TEST_SESSION)).map(textOf)).not.toContain('slack dm')
    const owed = await rig!.store.connectorReplies().readOwed(DM_DELIVERY.account, null, 10)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: readOwed returns only filled rows.
    const events = replyEventsOf(owed as Parameters<typeof replyEventsOf>[0])
    expect(events).toEqual([
      expect.objectContaining({
        conversation: expect.objectContaining({ externalId: 'D123' }),
        deliveryIds: [DM_DELIVERY.deliveryId],
        outcome: 'withdrawn'
      })
    ])
    expect(outcomeSentence(events[0].outcome, 'studio')).toBe('Stopped on studio.')
  })

  it('keeps a held card held in the new chat', async () => {
    const { chats } = await setup()
    const next = await chats.reset('bot-1')
    const { journal } = await rig!.host.conversation(next)
    expect(await journal.queuedMessages.get('unconfirmed')).toMatchObject({
      state: 'waiting',
      holdReason: QUEUED_MESSAGE_HELD_DELIVERY_UNCONFIRMED
    })
  })

  /** Replaces the chat with only the Plan card left to move, and resolves to what it sent there. */
  async function sendsPlanCard(newChatAgent: 'codex' | 'claude', agents?: StructuredAgentRegistry) {
    const { chats } = await setup(undefined, newChatAgent, agents)
    const { queuedMessages } = (await rig!.host.conversation(HOST_TEST_SESSION)).journal
    const others = (await queuedMessages.list()).filter(
      (card) => card.messageId !== 'plan' && card.messageId !== 'editing'
    )
    await queuedMessages.withdraw(others.map((card) => card.messageId))
    const next = await chats.reset('bot-1')
    expect(rig!.store.getConversation(next)?.provider).toBe(newChatAgent)
    const { journal } = await rig!.host.conversation(next)
    expect((await journal.queuedMessages.get('plan'))?.deliveryMode).not.toBe('steer')
    let sent: Parameters<QueuedMessageTestRig['dispatch']>[0] | undefined
    await eventually(() => {
      sent = rig!.dispatch.mock.calls.find(([input]) => input.sessionId === next)?.[0]
      expect(sent).toBeDefined()
    })
    return sent!.executionOptions
  }

  it('sends a moved card with the mode, model and effort it was queued with', async () => {
    expect(await sendsPlanCard('codex')).toMatchObject({
      interactionMode: 'plan',
      model: 'gpt-fixture',
      effort: 'high'
    })
  })

  it('keeps only Plan or Build when the new chat runs another agent', async () => {
    const options = await sendsPlanCard('claude')
    expect(options?.interactionMode).toBe('plan')
    expect(options?.model).not.toBe('gpt-fixture')
    expect(options?.effort).not.toBe('high')
  })

  it('drops the mode when the new chat runs an agent without one', async () => {
    expect((await sendsPlanCard('claude', NO_STRUCTURED_AGENTS))?.interactionMode).toBeUndefined()
  })

  it('keeps them in the old chat when the new chat cannot be made', async () => {
    const { chats } = await setup(async () => {
      throw new Error('start failed')
    })
    await expect(chats.reset('bot-1')).rejects.toThrow('start failed')
    expect((await queuedTexts(HOST_TEST_SESSION)).map(textOf)).toEqual([
      'owner text',
      'run result',
      'mail',
      'look at this',
      'slack dm',
      'maybe sent',
      'plan it first',
      'editing'
    ])
  })
})
