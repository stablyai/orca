import { describe, expect, it } from 'vitest'
import { discordInteractionResponse, readDiscordInteraction } from './discord-interactions.js'

// Shapes follow the interaction object and type tables in
// https://docs.discord.com/developers/interactions/receiving-and-responding and the button
// custom_id rules in https://docs.discord.com/developers/components/reference.
const guildBase = {
  id: '1300000000000000001',
  application_id: '1200000000000000000',
  token: 'interaction-token',
  guild_id: '1100000000000000000',
  channel_id: '1000000000000000000',
  member: { user: { id: '900000000000000000', username: 'owner' }, roles: [] },
  version: 1
}
const base = {
  guildId: '1100000000000000000',
  channelId: '1000000000000000000',
  userId: '900000000000000000'
}

describe('readDiscordInteraction', () => {
  it('reads a PING', () => {
    expect(readDiscordInteraction({ ...guildBase, type: 1 })).toEqual({ kind: 'ping' })
  })

  it('reads a button click with its custom_id and message', () => {
    expect(
      readDiscordInteraction({
        ...guildBase,
        type: 3,
        data: { custom_id: 'orca:approve:r1', component_type: 2 },
        message: { id: '1050000000000000000', content: 'Approve?' }
      })
    ).toEqual({
      ...base,
      kind: 'component',
      customId: 'orca:approve:r1',
      messageId: '1050000000000000000'
    })
  })

  it('ignores other types and refuses malformed payloads', () => {
    for (const type of [2, 5]) {
      expect(readDiscordInteraction({ ...guildBase, type, data: { custom_id: 'm' } })).toEqual({
        kind: 'ignored'
      })
    }
    expect(readDiscordInteraction({ ...guildBase, type: 3, data: { component_type: 2 } })).toEqual({
      kind: 'invalid'
    })
    expect(
      readDiscordInteraction({
        ...guildBase,
        type: 3,
        data: { custom_id: 'x'.repeat(101), component_type: 2 },
        message: { id: '1' }
      })
    ).toEqual({ kind: 'invalid' })
    expect(readDiscordInteraction({ id: '1' })).toEqual({ kind: 'invalid' })
  })
})

describe('discordInteractionResponse', () => {
  it('builds PONG, an ephemeral reply that mentions no one, and a deferred update', () => {
    expect(discordInteractionResponse.pong()).toEqual({ type: 1 })
    expect(discordInteractionResponse.ephemeral('Only the owner can answer')).toEqual({
      type: 4,
      data: { content: 'Only the owner can answer', flags: 64, allowed_mentions: { parse: [] } }
    })
    expect(discordInteractionResponse.deferredUpdate()).toEqual({ type: 6 })
  })
})
