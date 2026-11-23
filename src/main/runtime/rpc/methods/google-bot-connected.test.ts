import { describe, expect, it, vi } from 'vitest'
import type * as BotChatSession from '../../../bots/bot-chat-session'
import { GOOGLE_METHODS } from './google'

const sends: unknown[] = []
let defaultAccount: string | null = 'main@example.com'

vi.mock('../../../google/google-connect', () => ({
  getGoogleConnect: () => ({
    accounts: async () => [{ email: 'main@example.com' }, { email: 'work@example.com' }],
    defaultAccount: async () => defaultAccount
  })
}))

// The real bot chat send, over a host that records the turn it is handed.
vi.mock('../../../bots/bot-chat-session', async (actual) => {
  const real = await actual<typeof BotChatSession>()
  const host = {
    deps: {
      store: {
        getConversation: () => ({ sessionId: 'chat-1', provider: 'claude' }),
        requireWritableRecord: () => ({ lease: { runtimeFence: 1 } })
      }
    },
    send: async (_caller: unknown, input: unknown) => {
      sends.push(input)
      return { ok: true, value: { clientMessageId: 'm1', queued: {} } }
    },
    waitForSendSettlement: async () => undefined
  }
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

function connected(account: string) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only these runtime fields.
  const context = {
    caller: { kind: 'desktop-renderer' },
    runtime: {
      bots: {
        enabled: () => true,
        assertEnabled: () => {},
        list: () => [{ id: 'b1', agent: 'claude', chatSessionId: 'chat-1' }],
        setChatSession: async () => {}
      }
    }
  } as unknown as Parameters<typeof method.handler>[1]
  return method.handler({ botId: 'b1', account }, context)
}

describe('google.bot.connected', () => {
  it("tells the bot the account as a hidden card answer, never as the owner's message", async () => {
    sends.length = 0
    defaultAccount = 'main@example.com'
    await connected('work@example.com')
    defaultAccount = 'work@example.com'
    await connected('work@example.com')

    expect(sends).toHaveLength(2)
    for (const input of sends) {
      expect(input).not.toHaveProperty('personsMessage')
    }
    expect(sends.map((input) => (input as { body: unknown }).body)).toEqual([
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
})
