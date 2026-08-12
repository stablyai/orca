import { describe, expect, it } from 'vitest'
import { OFFLINE_DECODE_CHUNK_SECONDS, OfflineAudioChunker } from './stt-offline-audio-chunker'

// Why: a small rate keeps test arrays tiny while exercising the same
// seconds-based limits used with real 16 kHz audio.
const SAMPLE_RATE = 1000
const CHUNK_LIMIT = OFFLINE_DECODE_CHUNK_SECONDS * SAMPLE_RATE

function loudSignal(length: number): Float32Array {
  const samples = new Float32Array(length)
  for (let i = 0; i < length; i += 1) {
    samples[i] = Math.sin(i * 0.3) * 0.8
  }
  return samples
}

describe('OfflineAudioChunker', () => {
  it('buffers audio below the chunk limit without emitting chunks', () => {
    const chunker = new OfflineAudioChunker(SAMPLE_RATE)

    expect(chunker.push(loudSignal(CHUNK_LIMIT - 1))).toEqual([])
  })

  it('emits a bounded chunk once the limit is reached and keeps the remainder', () => {
    const chunker = new OfflineAudioChunker(SAMPLE_RATE)
    const total = CHUNK_LIMIT + 500

    const ready = chunker.push(loudSignal(total))
    const remainder = chunker.flush()

    expect(ready).toHaveLength(1)
    expect(ready[0].length).toBeLessThanOrEqual(CHUNK_LIMIT)
    expect(ready[0].length).toBeGreaterThan(0)
    expect(ready[0].length + (remainder?.length ?? 0)).toBe(total)
  })

  it('never emits a chunk larger than the limit across many small pushes', () => {
    const chunker = new OfflineAudioChunker(SAMPLE_RATE)
    const emitted: Float32Array[] = []
    const pushSize = 160
    const pushes = Math.ceil((CHUNK_LIMIT * 3.5) / pushSize)
    for (let i = 0; i < pushes; i += 1) {
      emitted.push(...chunker.push(loudSignal(pushSize)))
    }
    const remainder = chunker.flush()

    expect(emitted.length).toBeGreaterThanOrEqual(3)
    for (const chunk of emitted) {
      expect(chunk.length).toBeLessThanOrEqual(CHUNK_LIMIT)
    }
    const totalOut = emitted.reduce((sum, c) => sum + c.length, 0) + (remainder?.length ?? 0)
    expect(totalOut).toBe(pushes * pushSize)
  })

  it('splits multiple chunks out of one oversized push', () => {
    const chunker = new OfflineAudioChunker(SAMPLE_RATE)

    const ready = chunker.push(loudSignal(CHUNK_LIMIT * 2 + 100))

    expect(ready.length).toBeGreaterThanOrEqual(2)
    for (const chunk of ready) {
      expect(chunk.length).toBeLessThanOrEqual(CHUNK_LIMIT)
    }
  })

  it('splits at a silent pause near the chunk boundary instead of mid-speech', () => {
    const chunker = new OfflineAudioChunker(SAMPLE_RATE)
    const samples = loudSignal(CHUNK_LIMIT + 200)
    // Quiet gap 2 s before the limit, inside the 5 s split-search window.
    const gapStart = CHUNK_LIMIT - 2 * SAMPLE_RATE
    const gapEnd = gapStart + Math.round(0.2 * SAMPLE_RATE)
    samples.fill(0, gapStart, gapEnd)

    const [chunk] = chunker.push(samples)

    expect(chunk.length).toBeGreaterThanOrEqual(gapStart)
    expect(chunk.length).toBeLessThanOrEqual(gapEnd)
  })

  it('conserves sample values across the split', () => {
    const chunker = new OfflineAudioChunker(SAMPLE_RATE)
    const samples = loudSignal(CHUNK_LIMIT + 50)

    const [chunk] = chunker.push(samples)
    const remainder = chunker.flush()

    const rejoined = new Float32Array(samples.length)
    rejoined.set(chunk, 0)
    rejoined.set(remainder!, chunk.length)
    expect(rejoined).toEqual(samples)
  })

  it('flush returns null when nothing is buffered', () => {
    const chunker = new OfflineAudioChunker(SAMPLE_RATE)

    expect(chunker.flush()).toBeNull()
    expect(chunker.push(new Float32Array(0))).toEqual([])
    expect(chunker.flush()).toBeNull()
  })
})
