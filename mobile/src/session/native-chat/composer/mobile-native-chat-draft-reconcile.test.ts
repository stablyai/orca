import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import {
  findLandedImagePreviewEchoes,
  type PendingImagePreviewEcho
} from './mobile-native-chat-draft-reconcile'

function userText(id: string, text: string): NativeChatMessage {
  return {
    id,
    role: 'user',
    blocks: [{ type: 'text', text }],
    timestamp: null,
    source: 'transcript'
  }
}

function pending(
  id: string,
  images: string[],
  matchingOccurrence?: number
): PendingImagePreviewEcho {
  return { id, text: '', images, sentAt: 0, matchingOccurrence, afterMessageId: null }
}

describe('mobile native chat image preview reconciliation', () => {
  it('does not bind a glued image echo to an ordinary row with the same prefix', () => {
    const messages = [
      userText('ordinary', 'look at this later'),
      userText('source', '[Image: source: /tmp/a.png]'),
      userText('prompt', 'look at this[Image #1] is it still working?')
    ]
    const preview = { ...pending('pending', ['file:///a.jpg']), text: 'look at this' }

    expect(findLandedImagePreviewEchoes(messages, [preview])).toEqual([
      { pendingId: 'pending', messageId: 'prompt', images: ['file:///a.jpg'] }
    ])
  })

  it('keeps separate adjacent image-only sends independently reconcilable', () => {
    const landed = findLandedImagePreviewEchoes(
      [
        userText('source-a', '[Image: source: /tmp/a.png]'),
        userText('source-b', '[Image: source: /tmp/b.png]')
      ],
      [pending('pending-a', ['file:///a.jpg']), pending('pending-b', ['file:///b.jpg'], 2)]
    )

    expect(landed).toEqual([
      { pendingId: 'pending-a', messageId: 'source-a', images: ['file:///a.jpg'] },
      { pendingId: 'pending-b', messageId: 'source-b', images: ['file:///b.jpg'] }
    ])
  })

  it('waits for a complete multi-image turn as transcript source frames stream in', () => {
    const entry = pending('pending', ['file:///a.jpg', 'file:///b.jpg'])
    const sourceA = userText('source-a', '[Image: source: /tmp/a.png]')
    const sourceB = userText('source-b', '[Image: source: /tmp/b.png]')

    expect(findLandedImagePreviewEchoes([sourceA], [entry])).toEqual([])
    expect(findLandedImagePreviewEchoes([sourceA, sourceB], [entry])).toEqual([])
    expect(
      findLandedImagePreviewEchoes(
        [sourceA, sourceB, userText('prompt', '[Image #1] [Image #2]')],
        [entry]
      )
    ).toEqual([
      {
        pendingId: 'pending',
        messageId: 'prompt',
        images: ['file:///a.jpg', 'file:///b.jpg']
      }
    ])
  })

  it('binds past an older identical photo whose source row was the send boundary', () => {
    const messages = [
      userText('old-source', '[Image: source: /tmp/old.png]'),
      userText('old-prompt', 'look[Image #1]'),
      userText('new-source', '[Image: source: /tmp/new.png]'),
      userText('new-prompt', 'look[Image #1]')
    ]
    const preview = {
      ...pending('pending', ['file:///new.jpg']),
      text: 'look',
      afterMessageId: 'old-source'
    }

    expect(findLandedImagePreviewEchoes(messages, [preview])).toEqual([
      { pendingId: 'pending', messageId: 'new-prompt', images: ['file:///new.jpg'] }
    ])
  })
})
