import { describe, expect, it } from 'vitest'
import { createNativeChatMerger, replaceList } from '../../../src/shared/native-chat-merge'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { applyMobileNativeChatStreamFrame } from './mobile-native-chat-stream-frame'

function row(id: string, role: NativeChatMessage['role'] = 'assistant'): NativeChatMessage {
  return { id, role, source: 'transcript', timestamp: 1, blocks: [{ type: 'text', text: id }] }
}

function pair(id: string): NativeChatMessage[] {
  return [row(`${id}:reasoning`, 'reasoning'), row(id)]
}

describe('mobile complete-pair stream windows', () => {
  it.each(['appended', 'snapshot'])(
    'keeps a pair at the %s cutoff without moving the cursor',
    (type) => {
      const merger = createNativeChatMerger()
      const base = [
        ...pair('opencode:oldest'),
        ...Array.from({ length: 38 }, (_, i) => row(`m${i}`))
      ]
      replaceList(merger, base)
      const result = applyMobileNativeChatStreamFrame({
        merger,
        frame: {
          type,
          messages: type === 'snapshot' ? [...base.slice(-1), row('latest')] : [row('latest')],
          hasMore: true,
          beforeOffset: 1
        },
        limit: 40,
        replaceSnapshot: false
      })
      expect(result).toEqual({ kind: 'messages', messages: [...base, row('latest')] })
      expect(merger.indexById.get('opencode:oldest:reasoning')).toBe(0)
    }
  )

  it.each(['appended', 'snapshot'])(
    'keeps reasoning, answer and omission from one raw row at the %s cutoff',
    (type) => {
      const group = [...pair('opencode:oldest'), row('opencode:oldest:omission', 'system')].map(
        (message) => ({ ...message, transcriptOffset: 7 })
      )
      const base = [...group, ...Array.from({ length: 38 }, (_, i) => row(`m${i}`))]
      const merger = createNativeChatMerger()
      replaceList(merger, base)
      const result = applyMobileNativeChatStreamFrame({
        merger,
        frame: {
          type,
          messages: type === 'snapshot' ? [...base.slice(-1), row('latest')] : [row('latest')],
          hasMore: true,
          beforeOffset: 7
        },
        limit: 40,
        replaceSnapshot: false
      })
      expect(result).toEqual({ kind: 'messages', messages: [...base, row('latest')] })
      expect(merger.list.slice(0, 3)).toEqual(group)
      expect(merger.list).toHaveLength(42)
    }
  )

  it('invalidates the cursor when the oldest complete pair leaves', () => {
    const merger = createNativeChatMerger()
    const base = [...pair('opencode:oldest'), ...Array.from({ length: 39 }, (_, i) => row(`m${i}`))]
    replaceList(merger, base)
    const result = applyMobileNativeChatStreamFrame({
      merger,
      frame: { type: 'appended', messages: [row('latest')] },
      limit: 40,
      replaceSnapshot: false
    })
    expect(result).toEqual({
      kind: 'messages',
      messages: [...base.slice(2), row('latest')],
      cursorInvalidated: true,
      hasMore: true
    })
    expect(merger.indexById.has('opencode:oldest')).toBe(false)
    expect(merger.indexById.has('opencode:oldest:reasoning')).toBe(false)
  })

  it('retains a host page with an extra pair row across a user append followed by a pair append', () => {
    const merger = createNativeChatMerger()
    const base = [
      ...pair('opencode:first'),
      ...Array.from({ length: 13 }, (_, i) => [
        row(`user-${i}`, 'user'),
        ...pair(`opencode:${i}`)
      ]).flat()
    ]
    applyMobileNativeChatStreamFrame({
      merger,
      frame: { type: 'snapshot', messages: base, hasMore: true, beforeOffset: 123 },
      limit: 40,
      replaceSnapshot: true
    })
    applyMobileNativeChatStreamFrame({
      merger,
      frame: { type: 'appended', messages: [row('latest-user', 'user')] },
      limit: 40,
      replaceSnapshot: false
    })
    const result = applyMobileNativeChatStreamFrame({
      merger,
      frame: { type: 'appended', messages: pair('opencode:latest') },
      limit: 40,
      replaceSnapshot: false
    })
    expect(result).toMatchObject({ kind: 'messages', cursorInvalidated: true })
    expect(merger.list).toHaveLength(41)
    expect(merger.list.slice(0, 2)).toEqual(pair('opencode:0'))
    expect(merger.list.slice(-2)).toEqual(pair('opencode:latest'))
  })

  it('keeps legacy peers with independent reasoning IDs at the raw row limit', () => {
    const merger = createNativeChatMerger()
    replaceList(merger, [row('claude-thinking', 'reasoning'), row('claude-answer')])
    const result = applyMobileNativeChatStreamFrame({
      merger,
      frame: { type: 'appended', messages: [row('latest')] },
      limit: 2,
      replaceSnapshot: false
    })
    expect(result).toEqual({
      kind: 'messages',
      messages: [row('claude-answer'), row('latest')],
      cursorInvalidated: true,
      hasMore: true
    })
    expect(merger.list).toHaveLength(2)
  })
})
