import { describe, expect, it } from 'vitest'
import { createNativeChatMerger, replaceList } from '../../../src/shared/native-chat-merge'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
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
      beforeOffset: 123,
      windowReplaced: true
    })
  })

  it('marks a pending snapshot so the caller can settle the view but not the read', () => {
    const merger = createNativeChatMerger()
    const result = applyMobileNativeChatStreamFrame({
      merger,
      frame: { type: 'snapshot', messages: [], hasMore: false, pending: true },
      limit: 40,
      replaceSnapshot: true
    })

    expect(result).toEqual({
      kind: 'messages',
      messages: [],
      hasMore: false,
      windowReplaced: true,
      pending: true
    })
  })

  it('leaves an ordinary snapshot unmarked', () => {
    const merger = createNativeChatMerger()
    const result = applyMobileNativeChatStreamFrame({
      merger,
      frame: { type: 'snapshot', messages: [message('a')], hasMore: false },
      limit: 40,
      replaceSnapshot: true
    })

    expect(result).not.toHaveProperty('pending')
  })

  it('merges reconnect snapshots and live appends into the bounded window', () => {
    const merger = createNativeChatMerger()
    replaceList(merger, [message('a'), message('b')])

    const result = applyMobileNativeChatStreamFrame({
      merger,
      frame: {
        type: 'snapshot',
        messages: [message('b'), message('c'), message('d')],
        hasMore: true,
        beforeOffset: 20
      },
      limit: 3,
      replaceSnapshot: false
    })

    expect(result).toMatchObject({
      kind: 'messages',
      messages: [message('b'), message('c'), message('d')],
      cursorInvalidated: true,
      hasMore: true
    })
  })

  it('refreshes paging metadata when a replay still starts at the retained oldest row', () => {
    const merger = createNativeChatMerger()
    replaceList(merger, [message('a'), message('b')])

    expect(
      applyMobileNativeChatStreamFrame({
        merger,
        frame: {
          type: 'snapshot',
          messages: [message('a'), message('b')],
          hasMore: false,
          beforeOffset: 0
        },
        limit: 40,
        replaceSnapshot: false
      })
    ).toEqual({
      kind: 'messages',
      messages: [message('a'), message('b')],
      hasMore: false,
      beforeOffset: 0
    })
  })

  it('keeps paged-in history when a reconnect replay overlaps it', () => {
    const merger = createNativeChatMerger()
    replaceList(merger, ['p1', 'p2', 'a', 'b'].map(message))

    const result = applyMobileNativeChatStreamFrame({
      merger,
      // Replayed window: the retained tail plus what arrived while disconnected.
      frame: { type: 'snapshot', messages: [message('a'), message('b'), message('c')] },
      limit: 100,
      replaceSnapshot: false
    })

    expect(result).toEqual({
      kind: 'messages',
      messages: ['p1', 'p2', 'a', 'b', 'c'].map(message)
    })
  })

  it('ignores replay paging metadata that describes a row other than our oldest', () => {
    const merger = createNativeChatMerger()
    replaceList(merger, ['p1', 'p2', 'a', 'b'].map(message))

    // `beforeOffset` here points before 'a', not before 'p1'. Adopting it would
    // make the next loadEarlier re-fetch 'p1'/'p2' and prepend them twice.
    expect(
      applyMobileNativeChatStreamFrame({
        merger,
        frame: {
          type: 'snapshot',
          messages: [message('a'), message('b')],
          hasMore: true,
          beforeOffset: 500
        },
        limit: 100,
        replaceSnapshot: false
      })
    ).toEqual({ kind: 'messages', messages: ['p1', 'p2', 'a', 'b'].map(message) })
  })

  it('replaces the window when a reconnect replay is disjoint from history', () => {
    const merger = createNativeChatMerger()
    replaceList(merger, [message('old-1'), message('old-2')])

    // A long outage (or compaction while away) cannot be stitched without a gap.
    const result = applyMobileNativeChatStreamFrame({
      merger,
      frame: {
        type: 'snapshot',
        messages: [message('fresh-1'), message('fresh-2')],
        hasMore: true,
        beforeOffset: 900
      },
      limit: 100,
      replaceSnapshot: false
    })

    expect(result).toEqual({
      kind: 'messages',
      messages: [message('fresh-1'), message('fresh-2')],
      hasMore: true,
      beforeOffset: 900,
      windowReplaced: true
    })
  })

  it('replaces a partially overlapping replay that no longer extends the retained tail', () => {
    const merger = createNativeChatMerger()
    replaceList(merger, ['old-1', 'shared', 'old-tail'].map(message))

    // `hasMore: true` so the authoritative-removal rule can't short-circuit —
    // the contiguity scan itself must reject the interleaved new message.
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

  it('replaces a replay that repeats retained ids out of order', () => {
    const merger = createNativeChatMerger()
    replaceList(merger, ['a', 'b', 'c'].map(message))

    const replay = [message('a'), message('c'), message('b')]
    expect(
      applyMobileNativeChatStreamFrame({
        merger,
        frame: { type: 'snapshot', messages: replay, hasMore: true, beforeOffset: 4 },
        limit: 100,
        replaceSnapshot: false
      })
    ).toEqual({
      kind: 'messages',
      messages: replay,
      hasMore: true,
      beforeOffset: 4,
      windowReplaced: true
    })
  })

  it('replaces a replay that stops short of the retained newest row', () => {
    const merger = createNativeChatMerger()
    replaceList(merger, ['a', 'b', 'c'].map(message))

    // Merging would keep 'c', a row the replayed window no longer carries.
    const replay = [message('a'), message('b')]
    expect(
      applyMobileNativeChatStreamFrame({
        merger,
        frame: { type: 'snapshot', messages: replay, hasMore: true, beforeOffset: 1 },
        limit: 100,
        replaceSnapshot: false
      })
    ).toEqual({
      kind: 'messages',
      messages: replay,
      hasMore: true,
      beforeOffset: 1,
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

  it('replaces retained history when a single row precedes an authoritative replay', () => {
    const merger = createNativeChatMerger()
    replaceList(merger, ['removed-1', 'a', 'b'].map(message))

    // Boundary of the `firstIndex > 0` rule: one dropped row is still a dropped
    // row, and merging here would strand 'removed-1' the host no longer has.
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
    ).toEqual({
      kind: 'messages',
      messages: [message('new')],
      hasMore: false,
      windowReplaced: true
    })
  })

  it('still treats the base snapshot as authoritative after a replacement frame', () => {
    const merger = createNativeChatMerger()
    replaceList(merger, ['a', 'b'].map(message))

    // A replacement is not this subscription's base snapshot, so the first real
    // snapshot still replaces — merging would keep 'a', which it does not carry.
    expect(
      applyMobileNativeChatStreamFrame({
        merger,
        frame: {
          type: 'snapshot',
          messages: [message('b'), message('c')],
          hasMore: true,
          beforeOffset: 77
        },
        limit: 100,
        replaceSnapshot: true
      })
    ).toEqual({
      kind: 'messages',
      messages: [message('b'), message('c')],
      hasMore: true,
      beforeOffset: 77,
      windowReplaced: true
    })
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
