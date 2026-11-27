import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  answerBotOffer,
  answerBotOfferAgain,
  withBotOfferAnswer,
  type BotOfferAnswer,
  type BotOfferAnswerUpdate,
  type BotOfferTold
} from '../../../../shared/bots/bot-offer-answers'
import type * as BotChatSession from '../../../bots/bot-chat-session'
import type { RpcContext } from '../core'
import { BOT_OFFER_ANSWER_METHOD } from './bots-offer-answer'
import { GOOGLE_METHODS } from './google'

type Send = { envelope: { sessionId: string }; body: { blocks: { text: string }[] } }

// A bot whose chats all sit in its home; the chat queues every turn it takes, or refuses the next ones.
const { host, sends, chat } = vi.hoisted(() => {
  const sends: Send[] = []
  const chat = { refusing: 0 }
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
      if (chat.refusing > 0) {
        chat.refusing -= 1
        return { ok: false, refusal: { code: 'agent_session_not_writable' } }
      }
      sends.push(input)
      return { ok: true, value: { clientMessageId: `m${sends.length}`, queued: {} } }
    },
    waitForSendSettlement: async () => undefined
  }
  return { host, sends, chat }
})

vi.mock('../../../google/google-connect', () => ({
  getGoogleConnect: () => ({
    accounts: async () => [{ email: 'a@example.com' }, { email: 'b@example.com' }],
    defaultAccount: async () => 'a@example.com'
  })
}))

vi.mock('../../../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => host
}))

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

const googleConnected = GOOGLE_METHODS.find((entry) => entry.name === 'google.bot.connected')!
const caller = { kind: 'desktop' as const }

// A fresh host runtime per test, so no test sees another's remembered card answers.
let runtime: RpcContext['runtime']
beforeEach(() => {
  sends.length = 0
  chat.refusing = 0
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers read only these runtime fields.
  runtime = {
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
})

/** The card as the host keeps it on the bot (bots.update with an offerAnswer). */
function hostCard(cardId: string) {
  let answers: BotOfferAnswer[] = []
  return {
    cardId,
    answer: () => answers.find((entry) => entry.cardId === cardId),
    update: async (offerAnswer: BotOfferAnswerUpdate) => {
      answers = withBotOfferAnswer(answers, offerAnswer)
    }
  }
}

/** The host ran the call; with `lostReply`, its reply never reached the client. */
async function reply(call: Promise<BotOfferTold>, lostReply = false): Promise<BotOfferTold> {
  const told = await call
  if (lostReply) {
    throw new Error('The connection closed before the reply.')
  }
  return told
}

/** What the bot heard, in order. */
const turns = () => sends.map((send) => send.body.blocks[0]?.text)

describe('an import card pressed again after a lost reply', () => {
  const press = (card: ReturnType<typeof hostCard>, chosen: string[], lostReply = false) =>
    answerBotOffer(
      { cardId: card.cardId, sent: { chosen } },
      {
        update: card.update,
        send: (answerKey) =>
          reply(
            BOT_OFFER_ANSWER_METHOD.handler(
              { botId: 'b1', sessionId: 'chat-1', text: `Import ${chosen}`, answerKey, chosen },
              { caller, runtime }
            ),
            lostReply
          )
      }
    )

  it('imports once and shows the choice the bot heard, even when the owner changed it', async () => {
    const card = hostCard('plan')
    await expect(press(card, ['1', '2'], true)).rejects.toThrow('closed before the reply')
    // The card opens again, and the owner leaves item 2 out this time.
    expect(card.answer()?.sent).toBeUndefined()
    await expect(press(card, ['1'])).resolves.toBe('sent')

    expect(turns()).toEqual(['Import 1,2'])
    expect(card.answer()?.sent).toEqual({ chosen: ['1', '2'] })
  })

  it('imports once when the same choice is pressed again', async () => {
    const card = hostCard('plan')
    await expect(press(card, ['1'], true)).rejects.toThrow()
    await expect(press(card, ['1'])).resolves.toBe('sent')
    expect(turns()).toEqual(['Import 1'])
    expect(card.answer()?.sent).toEqual({ chosen: ['1'] })
  })

  it('sends a changed choice after the chat refused the first one', async () => {
    const card = hostCard('plan')
    chat.refusing = 1
    await expect(press(card, ['1', '2'])).resolves.toBe('refused')
    expect(card.answer()?.sent).toBeUndefined()
    await expect(press(card, ['2'])).resolves.toBe('sent')
    expect(turns()).toEqual(['Import 2'])
    expect(card.answer()?.sent).toEqual({ chosen: ['2'] })
  })

  it('shares one send between two presses at once, from two windows', async () => {
    const send = (chosen: string[]) =>
      BOT_OFFER_ANSWER_METHOD.handler(
        {
          botId: 'b1',
          sessionId: 'chat-1',
          text: `Import ${chosen}`,
          answerKey: 'plan\nsent\n0',
          chosen
        },
        { caller, runtime }
      )
    const [first, second] = await Promise.all([send(['1']), send(['2'])])
    expect([first, second]).toEqual([
      { sent: true, chosen: ['1'] },
      { sent: true, chosen: ['1'] }
    ])
    expect(turns()).toEqual(['Import 1'])
  })
})

describe('a Google card answered again and again', () => {
  const cardOps = (
    card: ReturnType<typeof hostCard>,
    account: string,
    { lostReply = false, sessionId }: { lostReply?: boolean; sessionId?: string } = {}
  ) => ({
    update: card.update,
    send: (answerKey: string) =>
      reply(
        googleConnected.handler(
          { botId: 'b1', account, answerKey, ...(sessionId ? { sessionId } : {}) },
          { caller, runtime }
        ),
        lostReply
      )
  })
  const first = (card: ReturnType<typeof hostCard>, account: string, options = {}) =>
    answerBotOffer(
      { cardId: card.cardId, sent: { chosen: [account] } },
      cardOps(card, account, options)
    )
  const again = (card: ReturnType<typeof hostCard>, account: string, options = {}) =>
    answerBotOfferAgain(
      { cardId: card.cardId, sent: { chosen: [account] } },
      card.answer(),
      cardOps(card, account, options)
    )
  const heard = () => turns().map((line) => line?.match(/account (\S+)/)?.[1])

  it('tells the bot each deliberate choice, revisits included', async () => {
    const card = hostCard('google')
    await expect(first(card, 'a@example.com')).resolves.toBe('sent')
    await expect(again(card, 'b@example.com')).resolves.toBe('sent')
    await expect(again(card, 'a@example.com')).resolves.toBe('sent')
    await expect(again(card, 'b@example.com')).resolves.toBe('sent')

    expect(heard()).toEqual(['a@example.com', 'b@example.com', 'a@example.com', 'b@example.com'])
    expect(card.answer()).toMatchObject({ sent: { chosen: ['b@example.com'] }, revision: 3 })
  })

  it('tells a retried further action once, and the next one still', async () => {
    const card = hostCard('google')
    await first(card, 'a@example.com')
    await expect(again(card, 'b@example.com', { lostReply: true })).rejects.toThrow()
    // The card shows A again until the retry lands.
    expect(card.answer()).toMatchObject({ sent: { chosen: ['a@example.com'] }, revision: 0 })
    await expect(again(card, 'b@example.com')).resolves.toBe('sent')
    await expect(again(card, 'a@example.com')).resolves.toBe('sent')

    expect(heard()).toEqual(['a@example.com', 'b@example.com', 'a@example.com'])
    expect(card.answer()).toMatchObject({ sent: { chosen: ['a@example.com'] }, revision: 2 })
  })

  it('tells the bot about a second account signed in after a lost reply', async () => {
    const card = hostCard('google')
    await expect(first(card, 'a@example.com', { lostReply: true })).rejects.toThrow()
    // Both accounts were granted, so the bot hears both, and the card shows the newer one.
    await expect(first(card, 'b@example.com')).resolves.toBe('sent')
    expect(heard()).toEqual(['a@example.com', 'b@example.com'])
    expect(card.answer()?.sent).toEqual({ chosen: ['b@example.com'] })
  })

  it('tells the bot once whether the card names its chat or leaves it to the home chat', async () => {
    const card = hostCard('google')
    await expect(first(card, 'a@example.com', { lostReply: true })).rejects.toThrow()
    await expect(first(card, 'a@example.com', { sessionId: 'chat-1' })).resolves.toBe('sent')
    expect(sends.map((send) => send.envelope.sessionId)).toEqual(['chat-1'])
  })

  it('puts a newer action back never, when an older one fails', async () => {
    const card = hostCard('google')
    await first(card, 'a@example.com')
    chat.refusing = 1
    const refused = again(card, 'b@example.com')
    // Another window answers the card again while this send is being refused.
    await card.update({ cardId: 'google', sent: { chosen: ['a@example.com'] }, revision: 2 })
    await expect(refused).resolves.toBe('refused')
    expect(card.answer()).toMatchObject({ sent: { chosen: ['a@example.com'] }, revision: 2 })
  })
})
