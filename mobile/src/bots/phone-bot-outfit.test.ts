import { describe, expect, it } from 'vitest'
import { mobileBotAvatarSource } from './host-bot-row-facts'
import { phoneBotSchema } from './host-bots-operations'

const BOT = {
  id: 'b1',
  name: 'Perf',
  folderWorkspaceId: 'fw-1',
  avatar: 'mascot:D1',
  paused: false,
  agent: 'claude',
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null
}

describe('phoneBotSchema', () => {
  it('keeps an outfit the phone draws', () => {
    expect(phoneBotSchema.parse({ ...BOT, avatarOutfit: 'tie' }).avatarOutfit).toBe('tie')
  })

  it("draws a newer host's outfit the phone can't draw as none, keeping the bot", () => {
    const bot = phoneBotSchema.parse({ ...BOT, avatarOutfit: 'snorkel' })
    expect(bot.id).toBe('b1')
    expect(mobileBotAvatarSource(bot)).toEqual({ kind: 'mascot', id: 'D1' })
  })
})
