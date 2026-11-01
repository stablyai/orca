import { describe, expect, it } from 'vitest'
import {
  appendWaitBlockedCarry,
  createWaitBlockedAppendedCarry,
  readWaitBlockedCarry
} from './wait-blocked-check-state'

import { MAX_TAIL_CHARS } from './terminal-tail-limits'

/** The accumulation this replaced, verbatim, as the equivalence oracle. */
function referenceAppend(previous: string, chunk: string): string {
  return previous.length + chunk.length > MAX_TAIL_CHARS
    ? `${previous}${chunk}`.slice(-MAX_TAIL_CHARS)
    : `${previous}${chunk}`
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('wait-blocked appended carry', () => {
  it('is byte-identical to the concat+slice carry across a 1MB flood in one 50ms window', () => {
    // A 50ms TUI flood must retain exactly the reference rolling window's bytes.
    const carry = createWaitBlockedAppendedCarry()
    let reference = ''
    const rng = mulberry32(20260902)
    let produced = 0
    let chunkIndex = 0
    while (produced < 1024 * 1024) {
      const size = 1 + Math.floor(rng() * 8192)
      const chunk = `${chunkIndex}:${'█'.repeat(Math.max(0, size - 3))}\n`
      chunkIndex += 1
      produced += chunk.length
      appendWaitBlockedCarry(carry, chunk)
      reference = referenceAppend(reference, chunk)
      expect(carry.chars).toBe(reference.length)
    }
    expect(readWaitBlockedCarry(carry)).toBe(reference)
    expect(reference.length).toBe(MAX_TAIL_CHARS)
  })

  it('matches the reference for boundary shapes: empty, exact-cap, and over-cap single chunks', () => {
    const cases: string[][] = [
      [],
      [''],
      ['abc', '', 'def'],
      ['x'.repeat(MAX_TAIL_CHARS)],
      ['x'.repeat(MAX_TAIL_CHARS), 'y'],
      ['a', 'b'.repeat(MAX_TAIL_CHARS + 5)],
      ['a'.repeat(MAX_TAIL_CHARS - 1), 'bc'],
      ['a'.repeat(10), 'b'.repeat(MAX_TAIL_CHARS - 10)],
      ['a'.repeat(10), 'b'.repeat(MAX_TAIL_CHARS - 10), 'c']
    ]
    for (const chunks of cases) {
      const carry = createWaitBlockedAppendedCarry()
      let reference = ''
      for (const chunk of chunks) {
        appendWaitBlockedCarry(carry, chunk)
        reference = referenceAppend(reference, chunk)
      }
      expect(readWaitBlockedCarry(carry)).toBe(reference)
      expect(carry.chars).toBe(reference.length)
    }
  })
})
