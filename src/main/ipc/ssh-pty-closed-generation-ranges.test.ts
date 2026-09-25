import { describe, expect, it } from 'vitest'
import { SshPtyClosedGenerationRanges } from './ssh-pty-closed-generation-ranges'

// Deterministic so a membership divergence reproduces from the failure output alone.
function lcg(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0
    return state / 0x1_0000_0000
  }
}

describe('SshPtyClosedGenerationRanges', () => {
  it('answers membership identically to a plain set under arbitrary insertion order', () => {
    const random = lcg(0xc0ffee)
    const ranges = new SshPtyClosedGenerationRanges()
    const oracle = new Set<number>()
    for (let step = 0; step < 4_000; step += 1) {
      const generation = 1 + Math.floor(random() * 400)
      ranges.add(generation)
      oracle.add(generation)
    }
    for (let generation = 0; generation <= 402; generation += 1) {
      expect([generation, ranges.has(generation)]).toEqual([generation, oracle.has(generation)])
    }
  })

  it('merges an inserted generation that bridges two ranges', () => {
    const ranges = new SshPtyClosedGenerationRanges()
    ranges.add(1)
    ranges.add(3)
    expect(ranges.size).toBe(2)

    ranges.add(2)

    expect(ranges.size).toBe(1)
    expect([1, 2, 3].map((generation) => ranges.has(generation))).toEqual([true, true, true])
    expect(ranges.has(4)).toBe(false)
  })

  it('treats a repeated close as a no-op', () => {
    const ranges = new SshPtyClosedGenerationRanges()
    ranges.add(7)
    ranges.add(7)
    expect(ranges.size).toBe(1)
    expect(ranges.activeGaps).toBe(6)
  })

  it('keeps insertion sublinear so a fragmented list cannot become quadratic', () => {
    // The scan this replaced took ~220ms to insert 20k non-adjacent generations and ~1300ms for
    // 100k membership probes against them; both are microseconds once the lookup is log-time.
    const ranges = new SshPtyClosedGenerationRanges()
    const startedAt = performance.now()
    for (let generation = 2; generation <= 80_000; generation += 2) {
      ranges.add(generation)
    }
    for (let probe = 0; probe < 100_000; probe += 1) {
      ranges.has(80_001)
    }
    const elapsed = performance.now() - startedAt

    expect(ranges.size).toBe(40_000)
    expect(elapsed).toBeLessThan(1_000)
  })
})
