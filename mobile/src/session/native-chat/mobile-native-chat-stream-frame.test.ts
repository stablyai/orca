import { describe, expect, it } from 'vitest'
import {
  createNativeChatMerger,
  replaceList
} from '../../../../src/shared/native-chat/native-chat-merge'
import type { NativeChatMessage } from '../../../../src/shared/native-chat/native-chat-types'
import { applyMobileNativeChatStreamFrame } from './mobile-native-chat-stream-frame'

function message(id: string): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text: id }],
    timestamp: 0,
    source: 'transcript'
  }
}

describe('applyMobileNativeChatStreamFrame', () => {
  it('replaces a partially overlapping replay that no longer extends the retained tail', () => {
    const merger = createNativeChatMerger()
    replaceList(merger, ['old-1', 'shared', 'old-tail'].map(message))

    // Keep hasMore true so only the contiguity check can reject the interleaved row.
    const replay = [message('shared'), message('compacted-summary'), message('old-tail')]
    expect(
      applyMobileNativeChatStreamFrame({
        merger,
        frame: { type: 'snapshot', messages: replay, hasMore: true, beforeOffset: 9 },
        limit: 100,
        replaceSnapshot: false
      })
    ).toEqual({
      kind: 'messages',
      messages: replay,
      hasMore: true,
      beforeOffset: 9,
      windowReplaced: true
    })
  })

  it('replaces retained history when replay metadata says no earlier rows remain', () => {
    const merger = createNativeChatMerger()
    replaceList(merger, ['removed-1', 'removed-2', 'a', 'b'].map(message))

    const replay = [message('a'), message('b')]
    expect(
      applyMobileNativeChatStreamFrame({
        merger,
        frame: { type: 'snapshot', messages: replay, hasMore: false, beforeOffset: 0 },
        limit: 100,
        replaceSnapshot: false
      })
    ).toEqual({
      kind: 'messages',
      messages: replay,
      hasMore: false,
      beforeOffset: 0,
      windowReplaced: true
    })
  })
})
