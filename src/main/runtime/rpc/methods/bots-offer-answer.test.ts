import { describe, expect, it, vi } from 'vitest'
import type * as BotChatSession from '../../../bots/bot-chat-session'
import type { RpcContext } from '../core'
import { BOT_OFFER_ANSWER_METHOD } from './bots-offer-answer'

type Send = {
  envelope: { sessionId: string }
  delivery?: string
  personsMessage?: boolean
  body: { origin?: string; blocks: { text: string }[] }
}

// A host whose agent is mid-turn: it holds every queued send as a card behind that turn.
const { host, sends } = vi.hoisted(() => {
  const sends: Send[] = []
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
      sends.push(input)
      return { ok: true, value: { clientMessageId: 'm1', queued: {} } }
    },
    waitForSendSettlement: async () => undefined
  }
  return { host, sends }
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
})
