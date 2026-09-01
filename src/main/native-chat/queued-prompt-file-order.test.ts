import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import { anchorQueuedPromptsToFileOrder, lastAnchorTimestamp } from './queued-prompt-file-order'

function message(overrides: Partial<NativeChatMessage> & { id: string }): NativeChatMessage {
  return {
    role: 'user',
    blocks: [{ type: 'text', text: overrides.id }],
    timestamp: 0,
    source: 'transcript',
    ...overrides
  }
}

describe('anchorQueuedPromptsToFileOrder', () => {
  it('lifts a queued prompt stamped before the record it was appended after', () => {
    const messages = [
      message({ id: 'u1', timestamp: 100 }),
      message({ id: 'a1', role: 'assistant', timestamp: 300 }),
      message({ id: 'q1', timestamp: 200, queued: true })
    ]

    expect(anchorQueuedPromptsToFileOrder(messages).map((m) => m.timestamp)).toEqual([
      100, 300, 301
    ])
  })

  // Why: equal timestamps fall to the id tie-break, which can put the queued
  // prompt above the record it was appended after.
  it('anchors a queued prompt stamped exactly at its predecessor', () => {
    const messages = [
      message({ id: 'work', role: 'assistant', timestamp: 300 }),
      message({ id: 'queued', timestamp: 300, queued: true })
    ]

    expect(anchorQueuedPromptsToFileOrder(messages).map((m) => m.timestamp)).toEqual([300, 301])
  })

  it('leaves a queued prompt that already sorts where the file put it', () => {
    const messages = [
      message({ id: 'u1', timestamp: 100 }),
      message({ id: 'q1', timestamp: 200, queued: true }),
      message({ id: 'a1', role: 'assistant', timestamp: 300 })
    ]

    expect(anchorQueuedPromptsToFileOrder(messages)).toBe(messages)
  })

  it('returns the same array when nothing is queued', () => {
    const messages = [
      message({ id: 'u1', timestamp: 300 }),
      message({ id: 'a1', role: 'assistant', timestamp: 100 })
    ]

    expect(anchorQueuedPromptsToFileOrder(messages)).toBe(messages)
  })

  it('anchors each queued prompt to its own predecessor', () => {
    const messages = [
      message({ id: 'a1', role: 'assistant', timestamp: 300 }),
      message({ id: 'q1', timestamp: 200, queued: true }),
      message({ id: 'a2', role: 'assistant', timestamp: 800 }),
      message({ id: 'q2', timestamp: 500, queued: true })
    ]

    expect(anchorQueuedPromptsToFileOrder(messages).map((m) => m.timestamp)).toEqual([
      300, 301, 800, 801
    ])
  })

  // Why: a live append batch can start with the queued record, so the previous
  // batch's last timestamp is the only predecessor available.
  it('anchors a batch that opens with a queued prompt against the seed', () => {
    const batch = [message({ id: 'q1', timestamp: 200, queued: true })]

    expect(anchorQueuedPromptsToFileOrder(batch, 500).map((m) => m.timestamp)).toEqual([501])
  })

  it('leaves a seeded batch alone when the queued prompt already sorts after it', () => {
    const batch = [message({ id: 'q1', timestamp: 900, queued: true })]

    expect(anchorQueuedPromptsToFileOrder(batch, 500)).toBe(batch)
  })

  it('reports the timestamp a following batch should anchor against', () => {
    const batch = [
      message({ id: 'a1', role: 'assistant', timestamp: 300 }),
      message({ id: 'q1', timestamp: 100, queued: true })
    ]
    const anchored = anchorQueuedPromptsToFileOrder(batch, null)

    expect(lastAnchorTimestamp(anchored, null)).toBe(301)
  })

  it('carries the fallback when a batch supplies no timestamp at all', () => {
    expect(lastAnchorTimestamp([message({ id: 'x', timestamp: null })], 700)).toBe(700)
  })

  it('keeps a null-timestamped queued prompt untouched', () => {
    const messages = [
      message({ id: 'u1', timestamp: 100 }),
      message({ id: 'q1', timestamp: null, queued: true })
    ]

    expect(anchorQueuedPromptsToFileOrder(messages)).toBe(messages)
  })
})
