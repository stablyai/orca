import { describe, expect, it, vi } from 'vitest'
import { GOOGLE_OWNER_ONLY } from '../../../bots/bot-google-access'
import { GOOGLE_METHODS } from './google'

const BOT_TOKEN = 'scout-token'
const setDefaultAccount = vi.fn(async (email: string) => email)
const disconnect = vi.fn()

vi.mock('../../../bots/tool-relay/bot-tool-relay', () => ({
  botToolRelay: { botOf: (token: string) => (token === BOT_TOKEN ? 'scout' : null) }
}))
vi.mock('../../../google/google-connect', () => ({
  getGoogleConnect: () => ({
    setDefaultAccount,
    disconnect,
    importClient: vi.fn(),
    exportClient: vi.fn(),
    accounts: async () => [{ email: 'me@example.com' }]
  })
}))

function call(name: string, params: Record<string, unknown>, google: boolean) {
  const method = GOOGLE_METHODS.find((entry) => entry.name === name)!
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers read only these runtime fields.
  const ctx = {
    runtime: {
      bots: {
        enabled: () => true,
        list: () => [{ id: 'scout', name: 'Scout', google }],
        assertEnabled: () => {}
      }
    }
  } as never
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each call passes that method's own params.
  return (method.handler as (params: unknown, ctx: unknown) => Promise<unknown>)(params, ctx)
}

describe('google methods from a bot run', () => {
  it('lets a bot with Google on set the default account, and refuses one with Google off', async () => {
    await expect(
      call('google.default.set', { botToken: BOT_TOKEN, account: 'me@example.com' }, true)
    ).resolves.toEqual({ defaultAccount: 'me@example.com' })
    expect(setDefaultAccount).toHaveBeenCalledWith('me@example.com')

    setDefaultAccount.mockClear()
    await expect(
      call('google.default.set', { botToken: BOT_TOKEN, account: 'me@example.com' }, false)
    ).rejects.toThrow(/Google is off for Scout/)
    await expect(
      call('google.default.set', { botToken: 'ended', account: 'me@example.com' }, true)
    ).rejects.toThrow(/token has ended/)
    expect(setDefaultAccount).not.toHaveBeenCalled()
  })

  it('still refuses the other owner-only Google changes', async () => {
    const refused = [
      call('google.disconnect', { botToken: BOT_TOKEN, account: 'me@example.com' }, true),
      call('google.client.import', { botToken: BOT_TOKEN, file: '/x.json' }, true),
      call('google.client.export', { botToken: BOT_TOKEN }, true),
      call('google.bot.set', { botToken: BOT_TOKEN, botId: 'scout', on: true }, true)
    ]
    for (const attempt of refused) {
      await expect(attempt).rejects.toThrow(GOOGLE_OWNER_ONLY)
    }
    expect(disconnect).not.toHaveBeenCalled()
  })
})
