import { describe, expect, it } from 'vitest'
import { transcriptFallbackId } from './transcript-fallback-id'

describe('transcriptFallbackId', () => {
  it('sorts line positions numerically when timestamps are unavailable', () => {
    const ids = [10, 2, 100, 9].map((offset) => transcriptFallbackId('/chat.jsonl', offset))

    expect(ids.sort()).toEqual([
      transcriptFallbackId('/chat.jsonl', 2),
      transcriptFallbackId('/chat.jsonl', 9),
      transcriptFallbackId('/chat.jsonl', 10),
      transcriptFallbackId('/chat.jsonl', 100)
    ])
  })

  it('sorts later incremental byte ranges after earlier ranges', () => {
    const earlier = transcriptFallbackId('/chat.jsonl', 99)
    const later = transcriptFallbackId('/chat.jsonl', 100)

    expect(earlier < later).toBe(true)
  })
})
