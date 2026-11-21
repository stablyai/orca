import { describe, expect, it } from 'vitest'
import { reviewAvatar } from './bot-share-review-avatar'

describe('reviewAvatar', () => {
  it('shows a shared mascot in its shared color and outfit, as the new bot will have it', () => {
    const review = {
      avatarDataUrl: null,
      bot: { name: 'Scout', avatar: { mascot: 'A1', color: '#f4c4cf', outfit: 'tie' } }
    }
    expect(reviewAvatar(review)).toEqual({
      kind: 'mascot',
      id: 'A1',
      color: '#f4c4cf',
      outfit: 'tie'
    })
  })
})
