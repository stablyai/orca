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

  // The cloud answers each call as `answer`; when `switchTo` is set, the host signs into that
  // account while the call is under way.
  function setUp(answer: unknown, switchTo?: string) {
    let account: string | null = 'acct-a'
    const update = vi.fn(async () => undefined)
    withHostCloudClient.mockReset()
    withHostCloudClient.mockImplementation(async () => {
      if (switchTo !== undefined) {
        account = switchTo
      }
      return { ok: true, value: answer }
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the Discord handlers read only these runtime fields.
    const context = {
      runtime: {
        getConnectorCloud: () => ({ signedInAccount: () => account }),
        bots: { list: () => [{ id: 'bot-1' }], update }
      }
    } as unknown as Context
    return { context, update }
  }

  const listed = {
    bots: [
      {
        botId: 'bot-1',
        state: 'ready',
        applicationId: '555',
        botUserId: '556',
        botName: 'Triage',
        guilds: [{ guildId: '900', name: 'Acme' }]
      }
    ]
  }

  it('records the list for the account that asked, and not once the account changed', async () => {
    const same = setUp(listed)
    await call('bots.discord.bots', null, same.context)
    expect(same.update).toHaveBeenCalledTimes(1)

    const changed = setUp(listed, 'acct-b')
    await expect(call('bots.discord.bots', null, changed.context)).resolves.toMatchObject({
      ok: true
    })
    expect(changed.update).not.toHaveBeenCalled()
  })

  it('does not clear the record of a removal or a left server once the account changed', async () => {
    const removed = setUp({}, 'acct-b')
    await call('bots.discord.remove', { botId: 'bot-1' }, removed.context)
    expect(removed.update).not.toHaveBeenCalled()

    const left = setUp(listed, 'acct-b')
    await call('bots.discord.leaveGuild', { botId: 'bot-1', guildId: '900' }, left.context)
    expect(left.update).not.toHaveBeenCalled()
  })
})
