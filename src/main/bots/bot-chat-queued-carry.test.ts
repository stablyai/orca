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
import { outcomeSentence, replyEventsOf } from '../connector-cloud/connector-reply-outbox'
import { botChatSessions } from './bot-chat-session'

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

  async function setup(createChat?: (sessionId: string) => Promise<void>) {
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
          providerHandle: { kind: 'codex', threadId: `thread-${sessionId}` }
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
      host: async () => current.host,
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
    expect(bodies.map(textOf)).toEqual(['owner text', 'run result', 'look at this', 'maybe sent'])
    expect(bodies[0].from).toBeUndefined()
    expect(bodies[1].from).toEqual(RESULT_SENDER)
    expect(bodies[2].blocks).toContainEqual(IMAGE)
    // Orchestration mail stays with the old chat's mailbox; a card being edited stays with its editor.
    expect((await queuedTexts(HOST_TEST_SESSION)).map(textOf)).toEqual(['mail', 'editing'])
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
      'editing'
    ])
  })
})
