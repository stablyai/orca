import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as BotChatSession from '../../../bots/bot-chat-session'
import type { RpcCallerIdentity } from '../callers/rpc-caller-identity'
import type { RpcContext } from '../core'
import { GOOGLE_METHODS } from './google'

type Send = { envelope: { sessionId: string }; body: { blocks: { text: string }[] } }

// Chats in b1's home, and one in another bot's home.
const { host, sends, state } = vi.hoisted(() => {
  const sends: Send[] = []
  const state: { defaultAccount: string | null } = { defaultAccount: 'main@example.com' }
  const host = {
    deps: {
      store: {
        getConversation: (sessionId: string) => ({
          sessionId,
          provider: 'claude',
          location: {
            workspaceId: sessionId === 'other-bot-chat' ? 'folder:home-2' : 'folder:home-1'
          }
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
  return { host, sends, state }
})

vi.mock('../../../google/google-connect', () => ({
  getGoogleConnect: () => ({
    accounts: async () => [{ email: 'main@example.com' }, { email: 'work@example.com' }],
    defaultAccount: async () => state.defaultAccount
  })
}))

vi.mock('../../../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => host
}))

// The real bot chat send, over a host that records the turn it is handed.
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

const method = GOOGLE_METHODS.find((entry) => entry.name === 'google.bot.connected')!
const caller: RpcCallerIdentity = { kind: 'desktop' }
const bots = {
  enabled: () => true,
  assertEnabled: () => {},
  list: () => [
    { id: 'b1', agent: 'claude', chatSessionId: 'chat-1', folderWorkspaceId: 'home-1' },
    { id: 'b2', agent: 'claude', chatSessionId: 'other-bot-chat', folderWorkspaceId: 'home-2' }
  ],
  setChatSession: async () => {}
}
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only the bots fields.
const runtime = { bots } as unknown as RpcContext['runtime']

function connected(account: string, sessionId?: string) {
  return method.handler(
    { botId: 'b1', account, ...(sessionId ? { sessionId } : {}) },
    {
      caller,
      runtime
    }
  )
}

const text = (input: Send) => input.body.blocks[0]?.text

describe('google.bot.connected', () => {
  beforeEach(() => {
    sends.length = 0
    state.defaultAccount = 'main@example.com'
  })

  it("tells the bot the account as a hidden card answer, never as the owner's message", async () => {
    await connected('work@example.com')
    state.defaultAccount = 'work@example.com'
    await connected('work@example.com')

    expect(sends).toHaveLength(2)
    for (const input of sends) {
      expect(input).not.toHaveProperty('personsMessage')
    }
    expect(sends.map((input) => input.body)).toEqual([
      expect.objectContaining({
        role: 'user',
        origin: 'card-answer',
        blocks: [
          {
            type: 'text',
            text: 'Connected Google account work@example.com (the default stays main@example.com).'
          }
        ]
      }),
      expect.objectContaining({
        origin: 'card-answer',
        blocks: [
          { type: 'text', text: 'Connected Google account work@example.com (now the default).' }
        ]
      })
    ])
  })

  it("answers in the chat the card sits in, and only in that bot's own chats", async () => {
    await connected('work@example.com', 'side-chat')
    expect(sends.map((input) => [input.envelope.sessionId, text(input)])).toEqual([
      [
        'side-chat',
        'Connected Google account work@example.com (the default stays main@example.com).'
      ]
    ])
    expect(sends[0]?.body).toMatchObject({ origin: 'card-answer' })

    await expect(connected('work@example.com', 'other-bot-chat')).rejects.toThrow(
      "That chat isn't one of this bot's."
    )
    expect(sends).toHaveLength(1)
  })
})
