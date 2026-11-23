import { describe, expect, it, vi } from 'vitest'
import { BOT_CREATE_METHOD } from './bots-create'

const sendToChat = vi.fn()

vi.mock('../../../bots/bot-chat-session', () => ({
  runtimeBotChats: () => ({ sendToChat })
}))

describe('bots.create', () => {
  it('reports a failed kickoff after creating the bot', async () => {
    sendToChat.mockRejectedValueOnce(new Error('agent unavailable'))
    const bot = { id: 'bot-1', name: 'Garden', agent: 'claude' }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only these runtime fields.
    const context = {
      runtime: {
        bots: {
          assertEnabled: () => {},
          create: async () => bot
        }
      }
    } as unknown as Parameters<typeof BOT_CREATE_METHOD.handler>[1]

    await expect(BOT_CREATE_METHOD.handler({ name: bot.name }, context)).resolves.toEqual({
      bot,
      kickoff: 'failed'
    })
    expect(sendToChat).toHaveBeenCalledWith(bot.id, expect.any(String), 'bot-created')
  })
})
