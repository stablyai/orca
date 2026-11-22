import { describe, expect, it } from 'vitest'
import { lookForOlderClient } from './bot-share-create'

const shared: Parameters<typeof lookForOlderClient>[2] = {
  avatar: { mascot: 'H1', color: '#f4c4cf', outfit: 'tie' }
}

describe('a shared bot created by a client from before shared looks', () => {
  it("gets the shared mascot's color and outfit", () => {
    expect(lookForOlderClient({ avatar: 'mascot:H1' }, {}, shared)).toEqual({
      avatarColor: '#f4c4cf',
      avatarOutfit: 'tie'
    })
  })

  it('keeps the look a newer client sent, and gives another mascot none', () => {
    expect(lookForOlderClient({ avatar: 'mascot:H1' }, { lookSent: true }, shared)).toEqual({})
    expect(lookForOlderClient({ avatar: 'mascot:A1' }, {}, shared)).toEqual({})
  })
})
