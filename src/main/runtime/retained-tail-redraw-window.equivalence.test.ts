import { describe, expect, it } from 'vitest'
import {
  appendNormalizedToTailBuffer,
  appendNormalizedToMultilineTailBufferUnwindowed
} from './orca-runtime'

// Differential guard for the windowed redraw tail path: the public
// appendNormalizedToTailBuffer routes vertical-control chunks through a
// suffix-windowed wrapper (findings log 2026-07-03 — the unwindowed path was
// O(tail) per chunk and dominated main's event loop under agent-TUI floods).
// This fuzz asserts the windowed result is byte-identical to the reference
// implementation across randomized tails and redraw chunks.

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randomTail(rng: () => number, maxLines: number): string[] {
  const count = Math.floor(rng() * maxLines)
  return Array.from({ length: count }, (_, i) => {
    const base = `line ${i} ${'x'.repeat(Math.floor(rng() * 40))}`
    // Trailing whitespace included deliberately: the reference implementation
    // trims every row on each call, so the windowed prefix must match.
    return rng() < 0.3 ? `${base}   ` : base
  })
}

function randomRedrawChunk(rng: () => number): string {
  const parts: string[] = []
  const ops = 1 + Math.floor(rng() * 12)
  for (let i = 0; i < ops; i++) {
    const roll = rng()
    if (roll < 0.2) {
      parts.push(`\x1b[${1 + Math.floor(rng() * 12)}A`)
    } else if (roll < 0.3) {
      parts.push(`\x1b[${Math.floor(rng() * 3)}J`)
    } else if (roll < 0.4) {
      parts.push(`\x1b[${Math.floor(rng() * 3)}K`)
    } else if (roll < 0.5) {
      parts.push('\r')
    } else if (roll < 0.6) {
      parts.push(`\x1b[${1 + Math.floor(rng() * 30)}G`)
    } else if (roll < 0.7) {
      parts.push('\n')
    } else if (roll < 0.75) {
      parts.push('')
    } else {
      parts.push(`text${Math.floor(rng() * 100)} ${'y'.repeat(Math.floor(rng() * 20))}`)
    }
  }
  return parts.join('')
}

describe('windowed redraw tail equivalence', () => {
  it('matches the unwindowed reference across 500 randomized cases', () => {
    const rng = mulberry32(42)
    for (let round = 0; round < 500; round++) {
      const tail = randomTail(rng, round % 5 === 0 ? 2100 : 300)
      const partial = rng() < 0.5 ? `partial ${'z'.repeat(Math.floor(rng() * 30))}` : ''
      const redrawCursor =
        rng() < 0.3 ? { rowFromEnd: Math.floor(rng() * 20), column: Math.floor(rng() * 40) } : null
      // Why the guaranteed cursor-up: the public function routes to the
      // multiline (windowed) path only for vertical-control chunks; chunks
      // without one take the single-line fast path, which is out of scope.
      const chunk = `\x1b[${1 + Math.floor(rng() * 4)}A${randomRedrawChunk(rng)}`

      const actual = appendNormalizedToTailBuffer(tail, partial, chunk, redrawCursor)
      // Reference path over the full tail.
      const expected = appendNormalizedToMultilineTailBufferUnwindowed(
        tail,
        partial.slice(-4000),
        chunk,
        partial.length > 4000,
        redrawCursor
      )

      expect(actual.lines, `round ${round} lines`).toEqual(expected.lines)
      expect(actual.partialLine, `round ${round} partial`).toBe(expected.partialLine)
      expect(actual.redrawCursor, `round ${round} cursor`).toEqual(expected.redrawCursor)
      expect(actual.truncated, `round ${round} truncated`).toBe(expected.truncated)
      expect(actual.newCompleteLines, `round ${round} newLines`).toBe(expected.newCompleteLines)
    }
  })
})
