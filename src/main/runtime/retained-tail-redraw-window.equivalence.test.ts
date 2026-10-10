import { describe, expect, it } from 'vitest'
import { mulberry32 } from '../../shared/agent-tui-ansi-fuzz-stream'
import { appendNormalizedToTailBuffer } from './terminal-tail-buffer'
import { MAX_TAIL_PARTIAL_CHARS } from './terminal-tail-limits'
import {
  appendNormalizedToMultilineTailBufferUnwindowed,
  type RetainedTailRedrawCursor
} from './terminal-tail-redraw-buffer'

// Differential guard for the windowed redraw tail path: the public
// appendNormalizedToTailBuffer routes vertical-control chunks through a
// suffix-windowed wrapper (findings log 2026-07-03 — the unwindowed path was
// O(tail) per chunk and dominated main's event loop under agent-TUI floods).
// This fuzz asserts the windowed result is byte-identical to the reference
// implementation across randomized tails and redraw chunks.

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

function expectMatchesUnwindowed(
  tail: string[],
  partial: string,
  chunk: string,
  redrawCursor: RetainedTailRedrawCursor | null,
  label: string
): void {
  const actual = appendNormalizedToTailBuffer(tail, partial, chunk, redrawCursor)
  // Reference path over the full tail.
  const expected = appendNormalizedToMultilineTailBufferUnwindowed(
    tail,
    partial.slice(-MAX_TAIL_PARTIAL_CHARS),
    chunk,
    partial.length > MAX_TAIL_PARTIAL_CHARS,
    redrawCursor
  )
  expect(actual, label).toEqual(expected)
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

      expectMatchesUnwindowed(tail, partial, chunk, redrawCursor, `round ${round}`)
    }
  })

  it('matches the reference when a chunk repeats multi-row repaint frames', () => {
    const rng = mulberry32(7)
    for (let round = 0; round < 80; round++) {
      // Why below the cap: both paths trim a full tail differently mid-chunk, which is out of scope.
      const tail = randomTail(rng, 1900)
      const partial = rng() < 0.5 ? `partial ${'z'.repeat(Math.floor(rng() * 30))}` : ''
      const redrawCursor =
        rng() < 0.3 ? { rowFromEnd: Math.floor(rng() * 20), column: Math.floor(rng() * 40) } : null
      // Why repeated frames: their summed cursor-ups exceed the tail while the net reach does not,
      // so only the net-reach window keeps these chunks windowed.
      const panelRows = 1 + Math.floor(rng() * 30)
      const frame = `\x1b[${panelRows}A${Array.from(
        { length: panelRows + Math.floor(rng() * 3) - 1 },
        () => `\r${randomRedrawChunk(rng).replace(/\n/g, '')}\n`
      ).join('')}`
      const chunk = frame.repeat(1 + Math.floor(rng() * 40))

      expectMatchesUnwindowed(tail, partial, chunk, redrawCursor, `round ${round}`)
    }
  })
})
