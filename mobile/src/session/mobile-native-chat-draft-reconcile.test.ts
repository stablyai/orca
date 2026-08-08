import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import {
  findLandedImagePreviewEchoes,
  migrateImagePreviewMessageIds,
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

function pending(id: string, images: string[], expectedOccurrence = 1): PendingImagePreviewEcho {
  return { id, text: '', images, expectedOccurrence, baselineTailMessageId: null }
}

describe('mobile native chat image preview reconciliation', () => {
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

  it('moves an early standalone preview to the later folded prompt id', () => {
    const sessionKey = 'host\0worktree\0tab\0session'
    const previous = { [sessionKey]: { source: ['file:///a.jpg'] } }
    const messages = [
      userText('source', '[Image: source: /tmp/a.png]'),
      userText('prompt', '[Image #1]')
    ]

    expect(migrateImagePreviewMessageIds(previous, sessionKey, messages)).toEqual({
      [sessionKey]: { prompt: ['file:///a.jpg'] }
    })
  })
})
