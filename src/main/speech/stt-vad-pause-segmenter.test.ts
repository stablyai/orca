import { describe, expect, it } from 'vitest'
import { VadPauseSegmenter, type VadStream } from './stt-vad-pause-segmenter'

// 100 Hz audio in 10-sample (0.1 s) frames; each sample holds its frame's speech probability, so outputs show which frames survived.
const RATE = 100
const FRAME = 10

function fakeVad(): VadStream {
  let pending: number[] = []
  let frames = 0
  const score = (flush: boolean) => {
    const probs: number[] = []
    while (pending.length >= FRAME || (flush && pending.length > 0)) {
      probs.push(pending[0])
      pending = pending.slice(FRAME)
    }
    const firstFrame = frames
    frames = flush ? 0 : frames + probs.length
    return { probs, firstFrame, segments: [] }
  }
  return {
    streamFeed: async (pcm) => {
      if (!(pcm instanceof Float32Array)) {
        throw new Error('the segmenter feeds Float32Array')
      }
      pending.push(...pcm)
      return score(false)
    },
    streamFlush: async () => score(true)
  }
}

function audio(frames: number[]): Float32Array {
  return Float32Array.from(frames.flatMap((probability) => Array(FRAME).fill(probability)))
}

function framesOf(chunks: Float32Array[]): number[][] {
  return chunks.map((chunk) =>
    Array.from(
      chunk.filter((_, index) => index % FRAME === 0),
      (value) => Math.round(value * 100) / 100
    )
  )
}

describe('VadPauseSegmenter', () => {
  it('commits a phrase at a 0.6 s pause, keeps 0.4 s ahead of the next, and drops the silence between', async () => {
    const segmenter = new VadPauseSegmenter(fakeVad(), RATE, FRAME)
    const first = await segmenter.push(audio([0.1, 0.9, 0.8, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2]))
    expect(framesOf(first)).toEqual([[0.1, 0.9, 0.8, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2]])
    expect(segmenter.heldSamples).toBe(0)

    const second = await segmenter.push(audio([0.1, 0.1, 0.1, 0.1, 0.1, 0.11, 0.12, 0.13, 0.14]))
    expect(second).toEqual([])
    // Only the last 0.4 s of that silence is held as the next phrase's lead-in.
    expect(segmenter.heldSamples).toBe(4 * FRAME)

    const rest = await segmenter.push(audio([0.7, 0.6]))
    expect(rest).toEqual([])
    expect(framesOf(await segmenter.flush())).toEqual([[0.11, 0.12, 0.13, 0.14, 0.7, 0.6]])
  })

  it('keeps a phrase whole across a pause shorter than 0.6 s', async () => {
    const segmenter = new VadPauseSegmenter(fakeVad(), RATE, FRAME)
    const ready = await segmenter.push(
      audio([0.9, 0.2, 0.2, 0.2, 0.2, 0.2, 0.9, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2])
    )
    expect(framesOf(ready)).toEqual([
      [0.9, 0.2, 0.2, 0.2, 0.2, 0.2, 0.9, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2]
    ])
  })

  it('returns nothing for a dictation that never had speech', async () => {
    const segmenter = new VadPauseSegmenter(fakeVad(), RATE, FRAME)
    expect(await segmenter.push(audio([0.1, 0.2, 0.3, 0.1]))).toEqual([])
    expect(await segmenter.flush()).toEqual([])
    expect(segmenter.heldSamples).toBe(0)
  })
})
