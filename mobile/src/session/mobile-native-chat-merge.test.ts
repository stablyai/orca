import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { mergeNativeChatMessages } from './mobile-native-chat-merge'

function msg(id: string, overrides: Partial<NativeChatMessage> = {}): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text: id }],
    timestamp: 0,
    source: 'transcript',
    ...overrides
  }
}

describe('mergeNativeChatMessages', () => {
  it('appends new ids in arrival order', () => {
    const merged = mergeNativeChatMessages([msg('a')], [msg('b'), msg('c')])
    expect(merged.map((m) => m.id)).toEqual(['a', 'b', 'c'])
  })

  it('replaces a re-emitted id in place without reordering', () => {
    const merged = mergeNativeChatMessages(
      [msg('a'), msg('b'), msg('c')],
      [msg('b', { blocks: [{ type: 'text', text: 'updated' }] })]
    )
    expect(merged.map((m) => m.id)).toEqual(['a', 'b', 'c'])
    expect(merged[1]!.blocks).toEqual([{ type: 'text', text: 'updated' }])
  })

  it('does not let a lower-priority source overwrite a higher one', () => {
    const merged = mergeNativeChatMessages(
      [msg('a', { source: 'transcript', blocks: [{ type: 'text', text: 'real' }] })],
      [msg('a', { source: 'scrape', blocks: [{ type: 'text', text: 'scraped' }] })]
    )
    expect(merged[0]!.blocks).toEqual([{ type: 'text', text: 'real' }])
  })

  it('returns the existing array unchanged for an empty batch', () => {
    const existing = [msg('a')]
    expect(mergeNativeChatMessages(existing, [])).toBe(existing)
  })

  it('does not mutate the existing array', () => {
    const existing = [msg('a')]
    mergeNativeChatMessages(existing, [msg('b')])
    expect(existing.map((m) => m.id)).toEqual(['a'])
  })
})
