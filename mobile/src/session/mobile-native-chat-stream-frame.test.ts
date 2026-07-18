import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { createNativeChatMerger, replaceList } from './mobile-native-chat-merge'
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
  it('uses the first snapshot as the ordered base and carries pagination state', () => {
    const merger = createNativeChatMerger()
    const result = applyMobileNativeChatStreamFrame({
      merger,
      frame: {
        type: 'snapshot',
        messages: [message('a'), message('b')],
        hasMore: true,
        beforeOffset: 123
      },
      limit: 40,
      replaceSnapshot: true
    })

    expect(result).toEqual({
      kind: 'messages',
      messages: [message('a'), message('b')],
      hasMore: true,
      beforeOffset: 123
    })
  })

  it('merges reconnect snapshots and live appends into the bounded window', () => {
    const merger = createNativeChatMerger()
    replaceList(merger, [message('a'), message('b')])

    const result = applyMobileNativeChatStreamFrame({
      merger,
      frame: { type: 'snapshot', messages: [message('b'), message('c'), message('d')] },
      limit: 3,
      replaceSnapshot: false
    })

    expect(result).toMatchObject({
      kind: 'messages',
      messages: [message('b'), message('c'), message('d')],
      cursorInvalidated: true
    })
  })

  it('keeps the pagination cursor when an append does not trim history', () => {
    const merger = createNativeChatMerger()
    replaceList(merger, [message('a')])

    expect(
      applyMobileNativeChatStreamFrame({
        merger,
        frame: { type: 'appended', messages: [message('b')] },
        limit: 3,
        replaceSnapshot: false
      })
    ).toEqual({ kind: 'messages', messages: [message('a'), message('b')] })
  })

  it('replaces stale history for an explicit transcript replacement frame', () => {
    const merger = createNativeChatMerger()
    replaceList(merger, [message('old')])

    expect(
      applyMobileNativeChatStreamFrame({
        merger,
        frame: { type: 'replacement', messages: [message('new')], hasMore: false },
        limit: 40,
        replaceSnapshot: false
      })
    ).toEqual({ kind: 'messages', messages: [message('new')], hasMore: false })
  })

  it('surfaces snapshot errors and ignores unrelated frames', () => {
    const merger = createNativeChatMerger()
    expect(
      applyMobileNativeChatStreamFrame({
        merger,
        frame: { type: 'snapshot', error: 'Transcript unavailable' },
        limit: 40,
        replaceSnapshot: true
      })
    ).toEqual({ kind: 'error', error: 'Transcript unavailable' })
    expect(
      applyMobileNativeChatStreamFrame({
        merger,
        frame: { type: 'error', message: 'Socket closed' },
        limit: 40,
        replaceSnapshot: false
      })
    ).toEqual({ kind: 'error', error: 'Socket closed' })
    expect(
      applyMobileNativeChatStreamFrame({
        merger,
        frame: { type: 'end' },
        limit: 40,
        replaceSnapshot: true
      })
    ).toEqual({ kind: 'ignored' })
  })
})
