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

  it('moves them, in order with sender and images, out of the old chat; mail stays', async () => {
    const { chats } = await setup()
    const next = await chats.reset('bot-1')
    expect(next).not.toBe(HOST_TEST_SESSION)
    const bodies = await received(next)
    expect(bodies.map(textOf)).toEqual(['owner text', 'run result', 'look at this'])
    expect(bodies[0].from).toBeUndefined()
    expect(bodies[1].from).toEqual(RESULT_SENDER)
    expect(bodies[2].blocks).toContainEqual(IMAGE)
    expect((await queuedTexts(HOST_TEST_SESSION)).map(textOf)).toEqual(['mail'])
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
      'look at this'
    ])
  })
})
