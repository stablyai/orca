import { describe, expect, it, vi } from 'vitest'
import { appendNormalizedToTailBuffer } from './terminal-tail-buffer'
import { MAX_TAIL_LINES } from './terminal-tail-limits'
import type { RetainedTailRedrawCursor } from './terminal-tail-redraw-buffer'

// Guards the per-chunk prefix work in appendNormalizedToTailBuffer: the retained char total is
// carried across appends and the redraw prefix is not re-scanned, so a saturated tail must not be
// walked once per chunk. Correctness is pinned by the cold/warm differential below — a "cold" run
// hands every append a fresh array so the memo always misses and every total is summed in full.

type TailSim = {
  lines: string[]
  partialLine: string
  redrawCursor: RetainedTailRedrawCursor | null
}

function newSim(): TailSim {
  return { lines: [], partialLine: '', redrawCursor: null }
}

type Step = ReturnType<typeof appendNormalizedToTailBuffer>

function feed(sim: TailSim, chunk: string, cold: boolean): Step {
  const next = appendNormalizedToTailBuffer(
    cold ? [...sim.lines] : sim.lines,
    sim.partialLine,
    chunk,
    sim.redrawCursor
  )
  sim.lines = next.lines
  sim.partialLine = next.partialLine
  sim.redrawCursor = next.redrawCursor
  return next
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ESC = String.fromCharCode(27)

/**
 * `short` fills the 2000-line cap and mixes in TUI redraws; `long` streams lines wide enough to
 * hit the 256 KiB character cap first. Both eviction paths adjust the carried character total, so
 * both need differential coverage, and a redraw's row truncation would keep `long` off its cap.
 */
function randomChunk(random: () => number, profile: 'short' | 'long'): string {
  const roll = random()
  if (profile === 'long') {
    if (roll < 0.7) {
      return `${'w'.repeat(1000 + Math.floor(random() * 3000))}\n`
    }
    if (roll < 0.8) {
      return `\rspinner ${Math.floor(random() * 100)}%`
    }
    if (roll < 0.9) {
      return 'trailing spaces here   \n'
    }
    return roll < 0.95 ? '' : `no newline ${Math.floor(random() * 1000)}`
  }
  if (roll < 0.22) {
    const lines: string[] = []
    for (let index = 0; index < 30; index += 1) {
      lines.push(`burst ${Math.floor(random() * 1e6)}${random() < 0.3 ? '   ' : ''}`)
    }
    return `${lines.join('\n')}\n`
  }
  if (roll < 0.42) {
    return `plain output ${Math.floor(random() * 1e6)}\n`
  }
  if (roll < 0.56) {
    return `${'   '.repeat(Math.floor(random() * 3))}\n`
  }
  if (roll < 0.68) {
    const rows = 1 + Math.floor(random() * 12)
    return `${ESC}[${rows}A${ESC}[2Kredrawn ${Math.floor(random() * 1000)}\n`
  }
  if (roll < 0.8) {
    return `\rspinner ${Math.floor(random() * 100)}%`
  }
  if (roll < 0.86) {
    return 'trailing spaces here   \n'
  }
  if (roll < 0.92) {
    return `multi\nline\nchunk ${Math.floor(random() * 1000)}\n`
  }
  if (roll < 0.96) {
    return ''
  }
  return `no newline ${Math.floor(random() * 1000)}`
}

describe('retained tail buffer prefix reuse', () => {
  for (const profile of ['short', 'long'] as const) {
    for (const seed of [3, 11, 91, 2024]) {
      it(`carries the retained char total exactly (${profile}, seed ${seed})`, () => {
        const random = mulberry32(seed)
        const warm = newSim()
        const cold = newSim()
        let sawCap = false
        for (let step = 0; step < 1400; step += 1) {
          const chunk = randomChunk(random, profile)
          const lineCountBefore = warm.lines.length
          const warmStep = feed(warm, chunk, false)
          const coldStep = feed(cold, chunk, true)
          expect(warmStep.lines, `step ${step} lines`).toEqual(coldStep.lines)
          expect(warmStep.partialLine, `step ${step} partial`).toBe(coldStep.partialLine)
          expect(warmStep.truncated, `step ${step} truncated`).toBe(coldStep.truncated)
          expect(warmStep.redrawCursor, `step ${step} cursor`).toEqual(coldStep.redrawCursor)
          expect(warmStep.newCompleteLines, `step ${step} newCompleteLines`).toBe(
            coldStep.newCompleteLines
          )
          expect(warmStep.newlyCompletedLines, `step ${step} newlyCompletedLines`).toEqual(
            coldStep.newlyCompletedLines
          )
          sawCap =
            sawCap ||
            (profile === 'short'
              ? warm.lines.length >= MAX_TAIL_LINES
              : // Lines dropped below the line cap on an append-only chunk == character-cap eviction.
                !chunk.includes(ESC) &&
                warm.lines.length < MAX_TAIL_LINES &&
                lineCountBefore + warmStep.newlyCompletedLines.length > warm.lines.length)
        }
        // Guard against a vacuous pass: the profile's eviction path must have run.
        expect(sawCap).toBe(true)
      })
    }
  }

  it('does not walk the untouched redraw prefix on every chunk', () => {
    const sim = newSim()
    for (let index = 0; index < MAX_TAIL_LINES + 200; index += 1) {
      feed(sim, `streaming build output line ${index}\n`, false)
    }
    expect(sim.lines.length).toBe(MAX_TAIL_LINES)

    const redrawChunk = `${ESC}[3A${ESC}[2Krewritten row${ESC}[2B\n`
    const spy = vi.spyOn(String.prototype, 'charCodeAt')
    let prefixTouches = 0
    try {
      feed(sim, redrawChunk, false)
      prefixTouches = spy.mock.calls.length
    } finally {
      spy.mockRestore()
    }
    // Before this change the prefix trailing-space scan alone cost one charCodeAt per retained
    // row (~1990); the chunk itself accounts for well under a hundred.
    expect(prefixTouches).toBeLessThan(300)
  })
})
