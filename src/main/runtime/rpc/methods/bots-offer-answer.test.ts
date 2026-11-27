import { describe, expect, it, vi } from 'vitest'
import type * as BotChatSession from '../../../bots/bot-chat-session'
import {
  answerBotOffer,
  withBotOfferAnswer,
  type BotOfferAnswer
} from '../../../../shared/bots/bot-offer-answers'
import type { RpcContext } from '../core'
import { BOT_OFFER_ANSWER_METHOD } from './bots-offer-answer'

type Send = {
  envelope: { sessionId: string }
  delivery?: string
  personsMessage?: boolean
  body: { origin?: string; blocks: { text: string }[] }
}

// A host whose agent is mid-turn: it holds every queued send as a card behind that turn.
const { host, sends, failing } = vi.hoisted(() => {
  const sends: Send[] = []
  // Sends that throw before reaching the agent, as a failed one would.
  const failing = { count: 0 }
  const host = {
    deps: {
      store: {
        getConversation: (sessionId: string) => ({
          sessionId,
          provider: 'claude',
          location: { workspaceId: 'folder:home-1' }
        }),
        requireWritableRecord: () => ({ lease: { runtimeFence: 1 } })
      }
    },
    send: async (_caller: unknown, input: Send) => {
      if (failing.count > 0) {
        failing.count -= 1
        throw new Error('The agent session host is restarting.')
      }
      sends.push(input)
      return { ok: true, value: { clientMessageId: 'm1', queued: {} } }
    },
    waitForSendSettlement: async () => undefined
  }
  return { host, sends, failing }
})

vi.mock('../../../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => host
}))

// The real bot chat send, over the host above.
vi.mock('../../../bots/bot-chat-session', async (actual) => {
  const real = await actual<typeof BotChatSession>()
  return {
    ...real,
    runtimeBotChats: (runtime: { bots: BotChatSession.BotChatDependencies['bots'] }) =>
      real.botChatSessions({
        bots: runtime.bots,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a send to an open Chat reads only these.
        host: async () => host as unknown as BotChatSession.BotChatHost,
        createChat: async () => {},
        showTab: async () => {},
        closeChat: async () => ({ stopped: true }),
        dropUnreadMail: async () => {}
      })
  }
})

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only these runtime fields.
const runtime = {
  bots: {
    enabled: () => true,
    assertEnabled: () => {},
    list: () => [
      { id: 'b1', agent: 'claude', chatSessionId: 'chat-1', folderWorkspaceId: 'home-1' }
    ],
    setChatSession: async () => {}
  },
  ensureStructuredAgentSessionHost: async () => host
} as unknown as RpcContext['runtime']

describe('bots.offer.answer', () => {
  it('waits behind the running turn as a card answer, never steering it as the owner', async () => {
    // The owner's follow-up setting lives in their client; the host path never reads it.
    await expect(
      BOT_OFFER_ANSWER_METHOD.handler(
        { botId: 'b1', sessionId: 'chat-1', text: 'Dismiss' },
        { caller: { kind: 'desktop' }, runtime }
      )
    ).resolves.toEqual({ sent: true })

    expect(sends).toHaveLength(1)
    expect(sends[0]).toMatchObject({
      envelope: { sessionId: 'chat-1' },
      delivery: 'queue-if-active',
      body: { origin: 'card-answer', blocks: [{ type: 'text', text: 'Dismiss' }] }
    })
    expect(sends[0]).not.toHaveProperty('personsMessage')
  })

  it('queues one answer when the reply to the first press is lost and the card is pressed again', async () => {
    sends.length = 0
    let answers: BotOfferAnswer[] = []
    // A desktop or paired-web press: claim on the host, then tell the bot over bots.offer.answer.
    const press = (lostReply: boolean) =>
      answerBotOffer(
        { cardId: 'card-1', sent: { chosen: ['ws-1'] } },
        {
          update: async (offerAnswer) => {
            answers = withBotOfferAnswer(answers, offerAnswer)
          },
          send: async (answerKey?: string) => {
            const { sent } = await BOT_OFFER_ANSWER_METHOD.handler(
              { botId: 'b1', sessionId: 'chat-1', text: 'Import ws-1', answerKey },
              { caller: { kind: 'desktop' }, runtime }
            )
            if (lostReply) {
              throw new Error('The connection closed before the reply.')
            }
            return { sent }
          }
        }
      )

    await expect(press(true)).rejects.toThrow('closed before the reply')
    // The card reads as unanswered again, so the owner can press it once more.
    expect(answers.find((entry) => entry.cardId === 'card-1')?.sent).toBeUndefined()
    await expect(press(false)).resolves.toBe('sent')

    expect(sends).toHaveLength(1)
  })

  it('drops a repeat of one card answer whichever chat it names, and keeps other cards apart', async () => {
    sends.length = 0
    const answer = (answerKey: string, sessionId = 'chat-1') =>
      BOT_OFFER_ANSWER_METHOD.handler(
        { botId: 'b1', sessionId, text: 'Dismiss', answerKey },
        { caller: { kind: 'desktop' }, runtime }
      )
    // Two windows pressing at once share the one send.
    const [first, second] = await Promise.all([
      answer('card-2\ndismissed'),
      answer('card-2\ndismissed')
    ])
    expect([first, second]).toEqual([{ sent: true }, { sent: true }])
    await answer('card-3\ndismissed')
    await answer('card-2\ndismissed', 'chat-2')
    expect(sends.map((send) => send.body.blocks[0]?.text)).toEqual(['Dismiss', 'Dismiss'])
    expect(sends).toHaveLength(2)
  })

  it('tells the bot on a press again after a send that failed on the host', async () => {
    sends.length = 0
    failing.count = 1
    const answer = () =>
      BOT_OFFER_ANSWER_METHOD.handler(
        { botId: 'b1', sessionId: 'chat-1', text: 'Dismiss', answerKey: 'card-4\ndismissed' },
        { caller: { kind: 'desktop' }, runtime }
      )
    await expect(answer()).rejects.toThrow('restarting')
    await expect(answer()).resolves.toEqual({ sent: true })
    expect(sends).toHaveLength(1)
  })
})
