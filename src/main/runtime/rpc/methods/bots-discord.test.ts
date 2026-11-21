import { describe, expect, it } from 'vitest'
import { nextBotDiscord } from './bots-discord'

const acme = {
  guildId: '900',
  guildName: 'Acme',
  roles: [{ id: '700', name: 'Engineers' }],
  channels: [{ id: '800', name: 'support' }]
}

describe('nextBotDiscord', () => {
  it('keeps a server’s limits, renames it, adds new servers and drops the ones it left', () => {
    const bot = {
      discord: { applicationId: '555', guilds: [acme, { guildId: '901', guildName: 'Old' }] }
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
      nextBotDiscord(bot, { state: 'broken', applicationId: '555', reason: 'token_revoked' })
    ).toBeUndefined()
    expect(nextBotDiscord(bot, { state: 'not_created' })).toBeNull()
    expect(nextBotDiscord({}, { state: 'not_created' })).toBeUndefined()
  })
})
