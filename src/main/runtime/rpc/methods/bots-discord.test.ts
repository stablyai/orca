import { describe, expect, it, vi } from 'vitest'

const { withHostCloudClient } = vi.hoisted(() => ({
  withHostCloudClient: vi.fn()
}))
vi.mock('./bots-slack', () => ({ withHostCloudClient }))

import { BOT_DISCORD_METHODS, nextBotDiscord } from './bots-discord'

const acme = {
  guildId: '900',
  guildName: 'Acme',
  roles: [{ id: '700', name: 'Engineers' }],
  channels: [{ id: '800', name: 'support' }]
}

describe('nextBotDiscord', () => {
  it('keeps a server’s limits, renames it, adds new servers and drops the ones it left', () => {
    const bot = {
      discord: {
        applicationId: '555',
        guilds: [acme, { guildId: '901', guildName: 'Old' }]
      }
    }
    expect(
      nextBotDiscord(bot, {
        state: 'ready',
        applicationId: '555',
        botUserId: '556',
        botName: 'Triage',
        guilds: [
          { guildId: '900', name: 'Acme Inc' },
          { guildId: '902', name: 'New' }
        ]
      })
    ).toEqual({
      applicationId: '555',
      guilds: [
        { ...acme, guildName: 'Acme Inc' },
        { guildId: '902', guildName: 'New' }
      ]
    })
  })

  it('changes nothing when the cloud reports the servers the record has', () => {
    const bot = { discord: { applicationId: '555', guilds: [acme] } }
    expect(
      nextBotDiscord(bot, {
        state: 'ready',
        applicationId: '555',
        botUserId: '556',
        botName: 'Triage',
        guilds: [{ guildId: '900', name: 'Acme' }]
      })
    ).toBeUndefined()
  })

  it('keeps the servers of a bot whose token broke, and clears a bot the cloud has no token for', () => {
    const bot = { discord: { applicationId: '555', guilds: [acme] } }
    expect(
      nextBotDiscord(bot, {
        state: 'broken',
        applicationId: '555',
        reason: 'token_revoked'
      })
    ).toBeUndefined()
    expect(nextBotDiscord(bot, { state: 'not_created' })).toBeNull()
    expect(nextBotDiscord({}, { state: 'not_created' })).toBeUndefined()
  })

  it('keeps at most eight servers, the recorded ones first, so the bot still loads', () => {
    const reported = Array.from({ length: 10 }, (_, i) => ({
      guildId: `9${i}`,
      name: `S${i}`
    }))
    const bot = {
      discord: {
        applicationId: '555',
        guilds: [{ guildId: '99', guildName: 'S9' }]
      }
    }
    const next = nextBotDiscord(bot, {
      state: 'ready',
      applicationId: '555',
      botUserId: '556',
      botName: 'Triage',
      guilds: reported
    })
    expect(next?.guilds.map((guild) => guild.guildId)).toEqual([
      '99',
      '90',
      '91',
      '92',
      '93',
      '94',
      '95',
      '96'
    ])
  })
})

describe('bots.discord answers after an account change', () => {
  type Context = Parameters<(typeof BOT_DISCORD_METHODS)[number]['handler']>[1]
  const call = (name: string, params: unknown, context: Context): Promise<unknown> => {
    const method = BOT_DISCORD_METHODS.find((entry) => entry.name === name)!
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each test passes the params its method's schema takes.
    const handler = method.handler as (params: unknown, context: Context) => Promise<unknown>
    return handler(params, context)
  }

  // The cloud answers each call as `answer`. With `switchTo`, the host signs into that account
  // while the call is under way ('call') or once a record edit is queued but before it runs
  // ('queued'), as when it waits behind earlier writes. Each edit's change is kept in `changes`.
  function setUp(answer: unknown, switchTo?: { account: string; when: 'call' | 'queued' }) {
    let account: string | null = 'acct-a'
    const changes: unknown[] = []
    const record = {
      discord: {
        applicationId: '555',
        guilds: [{ guildId: '901', guildName: 'Old' }]
      }
    }
    const update = vi.fn(async (_botId: string, edit: (bot: typeof record) => unknown) => {
      await Promise.resolve()
      if (switchTo?.when === 'queued') {
        account = switchTo.account
      }
      changes.push(edit(record))
    })
    withHostCloudClient.mockReset()
    withHostCloudClient.mockImplementation(async () => {
      if (switchTo?.when === 'call') {
        account = switchTo.account
      }
      return { ok: true, value: answer }
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the Discord handlers read only these runtime fields.
    const context = {
      runtime: {
        getConnectorCloud: () => ({
          signedInAccount: () => account,
          withConnection: (run: () => Promise<unknown>) => run()
        }),
        bots: { list: () => [{ id: 'bot-1' }], update }
      }
    } as unknown as Context
    return { context, changes }
  }

  const ready = {
    state: 'ready',
    applicationId: '555',
    botUserId: '556',
    botName: 'Triage',
    guilds: [{ guildId: '900', name: 'Acme' }]
  }
  const listed = { bots: [{ botId: 'bot-1', ...ready }] }
  // Made up, and built from parts so secret scanners don't read it as a leaked token.
  const token = ['A'.repeat(24), 'B'.repeat(6), 'C'.repeat(38)].join('.')
  const calls: [string, unknown, unknown][] = [
    ['bots.discord.bots', null, listed],
    ['bots.discord.setUp', { botId: 'bot-1', token }, ready],
    ['bots.discord.remove', { botId: 'bot-1' }, {}],
    ['bots.discord.leaveGuild', { botId: 'bot-1', guildId: '901' }, listed]
  ]

  it.each(calls)(
    '%s records the answer for the account that asked',
    async (name, params, answer) => {
      const same = setUp(answer)
      await call(name, params, same.context)
      expect(same.changes).toHaveLength(1)
      expect(same.changes[0]).toHaveProperty('discord')
    }
  )

  it.each(calls)(
    '%s records nothing once the account changed, during the call or behind queued writes',
    async (name, params, answer) => {
      for (const when of ['call', 'queued'] as const) {
        const changed = setUp(answer, { account: 'acct-b', when })
        await call(name, params, changed.context)
        expect(changed.changes.every((change) => JSON.stringify(change) === '{}')).toBe(true)
      }
    }
  )
})
