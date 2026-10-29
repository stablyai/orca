import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import {
  applyAppend,
  boundNativeChatWindow,
  createNativeChatMerger,
  mergeNativeChatMessages,
  replaceList
} from '../../../src/shared/native-chat/native-chat-merge'

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

// Compare each adversarial prefix with the pure merger so cached indexes cannot diverge from a full rebuild.
describe('mobile stateful merger — oracle vs pure merge', () => {
  const base = [msg('a'), msg('b', { source: 'hook' })]
  const batches: NativeChatMessage[][] = [
    [msg('c')],
    [],
    [msg('b', { source: 'transcript', blocks: [{ type: 'text', text: 'final' }] })],
    [msg('b', { source: 'scrape' })],
    [msg('a')],
    [msg('d'), msg('e')]
  ]

  it('matches the pure merge for every prefix', () => {
    const merger = createNativeChatMerger()
    replaceList(merger, base)
    let pure = mergeNativeChatMessages(base, [])
    expect(merger.list).toEqual(pure)
    for (const batch of batches) {
      const out = applyAppend(merger, batch)
      pure = mergeNativeChatMessages(pure, batch)
      expect(out).toEqual(pure)
    }
  })

  it('keeps prior row identity on a pure tail append', () => {
    const merger = createNativeChatMerger()
    replaceList(merger, base)
    const before = merger.list
    const tail = msg('z')
    const after = applyAppend(merger, [tail])
    expect(after).not.toBe(before)
    expect(after[0]).toBe(before[0])
    expect(after[after.length - 1]).toBe(tail)
  })

  it('bounds the window to the most-recent tail', () => {
    const long = Array.from({ length: 10 }, (_, i) => msg(`m${i}`))
    expect(boundNativeChatWindow(long, 3).map((m) => m.id)).toEqual(['m7', 'm8', 'm9'])
    expect(boundNativeChatWindow(long, 0)).toBe(long)
    expect(boundNativeChatWindow(long, 20)).toBe(long)
  })

  it('bounds live appends and rebuilds the cached indexes for the retained tail', () => {
    const merger = createNativeChatMerger()
    replaceList(merger, [msg('a'), msg('b'), msg('c')])

    expect(applyAppend(merger, [msg('d'), msg('e')], 3).map((m) => m.id)).toEqual(['c', 'd', 'e'])
    expect(merger.indexById.has('a')).toBe(false)
    expect(merger.indexById.get('c')).toBe(0)
    expect(
      applyAppend(merger, [msg('d', { blocks: [{ type: 'text', text: 'updated' }] })], 3)[1]
    ).toMatchObject({ id: 'd', blocks: [{ type: 'text', text: 'updated' }] })
  })
})
