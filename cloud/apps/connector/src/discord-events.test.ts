import { describe, expect, it } from 'vitest'
import { readDiscordMessage, threadParentOf } from './discord-events.js'

// Shapes from https://docs.discord.com/developers/resources/message and the GUILD_CREATE /
// THREAD_* events in https://docs.discord.com/developers/events/gateway-events.
const BOT = '1200000000000000000'
const message = {
  id: 'M1',
  channel_id: 'C1',
  guild_id: 'G1',
  author: { id: 'U1', username: 'owner' },
  content: `<@${BOT}> hi`,
  mentions: [{ id: BOT }],
  mention_roles: [],
  type: 0
}

describe('readDiscordMessage', () => {
  it('reads a member’s message and whether it mentions the bot', () => {
    expect(readDiscordMessage(message, BOT)).toEqual({
      guildId: 'G1',
      channelId: 'C1',
      messageId: 'M1',
      userId: 'U1',
      userName: 'owner',
      text: 'hi',
      mentioned: true
    })
    expect(
      readDiscordMessage(
        {
          ...message,
          member: { nick: 'Sam' },
          author: { id: 'U1', username: 'owner', global_name: 'O' }
        },
        BOT
      )?.userName
    ).toBe('Sam')
    expect(readDiscordMessage({ ...message, mentions: [] }, BOT)?.mentioned).toBe(false)
  })

  it.each([
    ['a DM', { guild_id: undefined }],
    ['a bot', { author: { id: 'B1', bot: true } }],
    ['ourselves', { author: { id: BOT } }],
    ['a webhook', { webhook_id: 'W1' }],
    ['a thread notice', { type: 18 }],
    ['a malformed payload', { id: undefined }]
  ])('drops %s', (_name, override) => {
    expect(readDiscordMessage({ ...message, ...override }, BOT)).toBeNull()
  })
})

describe('threadParentOf', () => {
  it('reads a thread’s parent, and none for a plain channel', () => {
    expect(threadParentOf({ id: 'T4', type: 12, parent_id: 'C4' })).toBe('C4')
    expect(threadParentOf({ id: 'C5', type: 0, parent_id: 'CAT1' })).toBeNull()
    expect(threadParentOf({ id: 'X' })).toBeUndefined()
  })
})
