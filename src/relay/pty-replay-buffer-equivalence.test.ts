import { describe, expect, it } from 'vitest'
import { RecentPtyOutputBuffer } from '../main/runtime/recent-pty-output-buffer'
import { REPLAY_BUFFER_MAX } from './pty-handler'

// Reference: the pre-change replay buffer, a rolling string sliced per append.
function appendStringTail(previous: string, data: string): string {
  if (data.length === 0) {
    return previous
  }
  const next = previous + data
  return next.length > REPLAY_BUFFER_MAX ? next.slice(-REPLAY_BUFFER_MAX) : next
}

function makeBuffer(): RecentPtyOutputBuffer {
  return new RecentPtyOutputBuffer({ preserveChunkBoundaries: false, limit: REPLAY_BUFFER_MAX })
}

function replayEquals(chunks: string[]): { deque: string; reference: string } {
  const buffer = makeBuffer()
  let reference = ''
  for (const chunk of chunks) {
    buffer.append(chunk)
    reference = appendStringTail(reference, chunk)
  }
  return { deque: buffer.read(), reference }
}

// Deterministic PRNG so a failure is reproducible.
function makeRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

describe('relay replay buffer equivalence', () => {
  it('matches the rolling-string tail below the cap', () => {
    const { deque, reference } = replayEquals(['hello ', 'world', '\r\n$ '])
    expect(deque).toBe(reference)
    expect(deque).toBe('hello world\r\n$ ')
  })

  it('matches once the window saturates', () => {
    const chunks = Array.from({ length: 40 }, (_value, index) => `chunk-${index}-`.repeat(400))
    const { deque, reference } = replayEquals(chunks)
    expect(deque.length).toBe(REPLAY_BUFFER_MAX)
    expect(deque).toBe(reference)
  })

  it('matches when one append alone exceeds the cap', () => {
    const { deque, reference } = replayEquals(['x'.repeat(REPLAY_BUFFER_MAX * 2 + 7)])
    expect(deque.length).toBe(REPLAY_BUFFER_MAX)
    expect(deque).toBe(reference)
  })

  it('matches when an oversized append follows existing content', () => {
    const { deque, reference } = replayEquals(['prefix', 'y'.repeat(REPLAY_BUFFER_MAX + 3)])
    expect(deque).toBe(reference)
    expect(deque.startsWith('prefix')).toBe(false)
  })

  it('matches at exactly the cap boundary', () => {
    for (const total of [REPLAY_BUFFER_MAX - 1, REPLAY_BUFFER_MAX, REPLAY_BUFFER_MAX + 1]) {
      const { deque, reference } = replayEquals(['a'.repeat(total)])
      expect(deque).toBe(reference)
    }
  })

  it('ignores empty appends exactly as the string form did', () => {
    const { deque, reference } = replayEquals(['a', '', 'b', '', 'c'])
    expect(deque).toBe(reference)
    expect(deque).toBe('abc')
  })

  it('is stable across repeated reads', () => {
    const buffer = makeBuffer()
    for (let index = 0; index < 200; index += 1) {
      buffer.append(`line ${index}\r\n`.repeat(30))
    }
    expect(buffer.read()).toBe(buffer.read())
  })

  it('keeps appending correctly after a read collapses the deque', () => {
    const buffer = makeBuffer()
    let reference = ''
    for (let index = 0; index < 60; index += 1) {
      const chunk = `mid-${index}-`.repeat(300)
      buffer.append(chunk)
      reference = appendStringTail(reference, chunk)
      // Interleave reads: attach/adopt/revive can land at any point in the stream.
      if (index % 7 === 0) {
        expect(buffer.read()).toBe(reference)
      }
    }
    expect(buffer.read()).toBe(reference)
  })

  // Why fuzz: the deque trims across chunk boundaries with a deferred head offset,
  // so the risky cases are irregular chunk sizes straddling the cap repeatedly.
  it('matches the rolling string across randomized chunk streams', () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const random = makeRandom(seed)
      const buffer = makeBuffer()
      let reference = ''
      for (let step = 0; step < 120; step += 1) {
        const size = Math.floor(random() * (REPLAY_BUFFER_MAX / 8))
        const chunk = String.fromCharCode(97 + (step % 26)).repeat(size)
        buffer.append(chunk)
        reference = appendStringTail(reference, chunk)
      }
      expect(buffer.read(), `seed ${seed}`).toBe(reference)
    }
  })

  // Why surrogates: trimming by code unit can split a pair, and the string form did
  // exactly the same thing. The deque must not "fix" it into a different tail.
  it('splits surrogate pairs identically to the rolling string', () => {
    // Why the trailing unit: the cap is even and a pair is 2 units, so an emoji run
    // alone always cuts on a pair boundary. One odd unit shifts the cut mid-pair.
    const { deque, reference } = replayEquals([`${'\u{1F600}'.repeat(REPLAY_BUFFER_MAX)}z`])
    expect(deque).toBe(reference)
    expect(deque.length).toBe(REPLAY_BUFFER_MAX)
    const leadUnit = deque.charCodeAt(0)
    expect(leadUnit).toBeGreaterThanOrEqual(0xdc00)
    expect(leadUnit).toBeLessThanOrEqual(0xdfff)
  })

  it('keeps a pair-aligned tail intact when the cut lands on a boundary', () => {
    const { deque, reference } = replayEquals(['\u{1F600}'.repeat(REPLAY_BUFFER_MAX)])
    expect(deque).toBe(reference)
    const leadUnit = deque.charCodeAt(0)
    expect(leadUnit).toBeGreaterThanOrEqual(0xd800)
    expect(leadUnit).toBeLessThanOrEqual(0xdbff)
  })
})
