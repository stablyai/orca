import { describe, expect, it, vi } from 'vitest'
import { GOOGLE_OWNER_ONLY, hostGoogleBotState } from '../../../bots/bot-google-access'
import { googleCallerAccount } from '../google-caller-api'
import { GOOGLE_METHODS } from './google'

const BOT_TOKEN = 'scout-token'
const setDefaultAccount = vi.fn(async (email: string) => email)
const disconnect = vi.fn()
const checkAccounts = vi.fn(async (_only?: (email: string) => boolean) => [
  hostAccount('Me@Gmail.com')
])
type DefaultRead = { email: string } | { unreadable: string; accounts: string[] }
const computerDefault: { read: DefaultRead } = vi.hoisted(() => ({
  read: { email: 'me@work.com' }
}))
const hostAccount = (email: string) => ({
  email,
  status: 'connected',
  services: [],
  connectedAt: 0
})

vi.mock('../../../bots/tool-relay/bot-tool-relay', () => ({
  botToolRelay: { botOf: (token: string) => (token === BOT_TOKEN ? 'scout' : null) }
}))
vi.mock('../../../google/google-credential-store', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readGoogleDefaultAccount: async () => computerDefault.read
}))
vi.mock('../../../google/google-connect', () => ({
  getGoogleConnect: () => ({
    setDefaultAccount,
    disconnect,
    importClient: vi.fn(),
    exportClient: vi.fn(),
    accounts: async () => [hostAccount('me@work.com'), hostAccount('Me@Gmail.com')],
    client: async () => ({ clientId: 'client' }),
    clientCheck: async () => null,
    checkClient: async () => null,
    checkAccounts,
    defaultAccount: async () => 'me@work.com'
  })
}))

function runtime(bot: { google: boolean; googleAccounts?: string[] }) {
  let saved = { id: 'scout', name: 'Scout', members: [], ...bot }
  return {
    bots: {
      enabled: () => true,
      list: () => [saved],
      assertEnabled: () => {},
      update: async (_id: string, edit: (current: typeof saved) => Partial<typeof saved>) => {
        saved = { ...saved, ...edit(saved) }
        return saved
      }
    }
  }
}

function call(
  name: string,
  params: Record<string, unknown>,
  google: boolean | { google: boolean; googleAccounts?: string[] }
) {
  const method = GOOGLE_METHODS.find((entry) => entry.name === name)!
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers read only these runtime fields.
  const ctx = { runtime: runtime(typeof google === 'boolean' ? { google } : google) } as never
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

  it('keeps a bot with chosen accounts to them, and its default to its own', async () => {
    const scout = { google: true, googleAccounts: ['me@gmail.com'] }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: googleCallerAccount reads only these runtime fields.
    const ctx = { runtime: runtime(scout) } as never
    await expect(
      googleCallerAccount({ botToken: BOT_TOKEN, account: 'me@work.com' }, ctx)
    ).rejects.toThrow("Scout can't use me@work.com")
    await expect(
      googleCallerAccount({ botToken: BOT_TOKEN, account: 'ME@gmail.com' }, ctx)
    ).resolves.toBe('ME@gmail.com')
    // The computer default (me@work.com) isn't Scout's, so its first account is.
    await expect(googleCallerAccount({ botToken: BOT_TOKEN }, ctx)).resolves.toBe('me@gmail.com')
    await expect(
      call('google.default.set', { botToken: BOT_TOKEN, account: 'me@work.com' }, scout)
    ).rejects.toThrow("Scout can't use me@work.com")

    // Google on with no list is every account: the owner's choice passes through unchanged.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above.
    const every = { runtime: runtime({ google: true }) } as never
    await expect(
      googleCallerAccount({ botToken: BOT_TOKEN, account: 'me@work.com' }, every)
    ).resolves.toBe('me@work.com')
    await expect(googleCallerAccount({ botToken: BOT_TOKEN }, every)).resolves.toBeUndefined()
  })
})

describe('google.bot.set from the owner', () => {
  it('saves chosen accounts, and clears them for --on (every account) and --off', async () => {
    const method = GOOGLE_METHODS.find((entry) => entry.name === 'google.bot.set')!
    const ctx = { runtime: runtime({ google: false }) }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only these runtime fields.
    const handler = method.handler as (params: unknown, ctx: unknown) => Promise<{ bot: unknown }>
    const set = (params: Record<string, unknown>) => handler({ botId: 'scout', ...params }, ctx)
    await expect(set({ on: true, accounts: ['me@gmail.com'] })).resolves.toMatchObject({
      bot: { google: true, accounts: ['me@gmail.com'] }
    })
    expect((await set({ on: true })).bot).toEqual({ id: 'scout', name: 'Scout', google: true })
    await set({ on: true, accounts: ['me@gmail.com'] })
    expect((await set({ on: false })).bot).toEqual({ id: 'scout', name: 'Scout', google: false })
    expect(ctx.runtime.bots.list()[0]?.googleAccounts).toBeUndefined()
  })
})

describe('Google as a bot limited to some accounts sees it', () => {
  it('shows only its accounts and the default its own calls use', async () => {
    await expect(
      call(
        'google.status',
        { botToken: BOT_TOKEN },
        { google: true, googleAccounts: ['me@gmail.com'] }
      )
    ).resolves.toMatchObject({
      accounts: [{ email: 'Me@Gmail.com' }],
      defaultAccount: 'me@gmail.com'
    })
    await expect(call('google.status', {}, { google: true })).resolves.toMatchObject({
      accounts: [{ email: 'me@work.com' }, { email: 'Me@Gmail.com' }],
      defaultAccount: 'me@work.com'
    })
  })

  it('reads the host as connected only through its own accounts', async () => {
    await expect(
      hostGoogleBotState({ google: true, googleAccounts: ['gone@x.com'] })
    ).resolves.toEqual({ allowed: true, host: 'signed-out' })
    await expect(
      hostGoogleBotState({ google: true, googleAccounts: ['me@gmail.com'] })
    ).resolves.toEqual({ allowed: true, host: 'connected' })
  })

  it('refuses to guess among several accounts when the default is unreadable', async () => {
    computerDefault.read = { unreadable: 'Keychain denied.', accounts: ['me@work.com'] }
    try {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: googleCallerAccount reads only these runtime fields.
      const several = {
        runtime: runtime({ google: true, googleAccounts: ['a@x.com', 'b@x.com'] })
      } as never
      await expect(googleCallerAccount({ botToken: BOT_TOKEN }, several)).rejects.toThrow(
        "Couldn't read this computer's default Google account. Keychain denied. Name one with --account: a@x.com, b@x.com."
      )
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above.
      const one = { runtime: runtime({ google: true, googleAccounts: ['a@x.com'] }) } as never
      await expect(googleCallerAccount({ botToken: BOT_TOKEN }, one)).resolves.toBe('a@x.com')
    } finally {
      computerDefault.read = { email: 'me@work.com' }
    }
  })

  it('checks only its own accounts with --check', async () => {
    await call(
      'google.status',
      { botToken: BOT_TOKEN, check: true },
      { google: true, googleAccounts: ['me@gmail.com'] }
    )
    const only = checkAccounts.mock.calls.at(-1)?.[0]
    expect(only?.('ME@gmail.com')).toBe(true)
    expect(only?.('me@work.com')).toBe(false)
    await call('google.status', { check: true }, { google: true })
    expect(checkAccounts.mock.calls.at(-1)?.[0]).toBeUndefined()
  })
})
