import { describe, expect, it, vi } from 'vitest'
import { appendNormalizedToTailBuffer } from './terminal-tail-buffer'
import { MAX_TAIL_CHARS, MAX_TAIL_LINES } from './terminal-tail-limits'
import { buildPreview } from './terminal-tail-state'
import {
  getTerminalTailSentinelFullScanCount,
  getTerminalTailSentinelMatches,
  tailMayContainBlockedSignal
} from './terminal-tail-sentinel-index'
import { computeTerminalTailWaitState } from './terminal-wait-tail-state'
import { TERMINAL_WAIT_BLOCKED_SENTINEL_RE } from './terminal-wait-detection'
import type { RetainedTailRedrawCursor } from './terminal-tail-redraw-buffer'

// The definition the incremental index must reproduce: does ANY retained line (or the
// partial line) match the sentinel? Written out independently of the implementation.
function referenceMayContainBlockedSignal(lines: string[], partialLine: string): boolean {
  for (const line of lines) {
    if (TERMINAL_WAIT_BLOCKED_SENTINEL_RE.test(line)) {
      return true
    }
  }
  return TERMINAL_WAIT_BLOCKED_SENTINEL_RE.test(partialLine)
}

function indexedMayContainBlockedSignal(lines: string[], partialLine: string): boolean {
  return tailMayContainBlockedSignal(lines) || TERMINAL_WAIT_BLOCKED_SENTINEL_RE.test(partialLine)
}

type TailSim = {
  lines: string[]
  partialLine: string
  redrawCursor: RetainedTailRedrawCursor | null
  preview: string
}

function newSim(): TailSim {
  return { lines: [], partialLine: '', redrawCursor: null, preview: '' }
}

function feed(sim: TailSim, chunk: string): void {
  const next = appendNormalizedToTailBuffer(sim.lines, sim.partialLine, chunk, sim.redrawCursor)
  sim.lines = next.lines
  sim.partialLine = next.partialLine
  sim.redrawCursor = next.redrawCursor
  sim.preview = buildPreview(next.lines, next.partialLine)
}

/** A structurally identical tail the index has never seen, so it takes the full-scan path. */
function unindexed(sim: TailSim): string[] {
  return [...sim.lines]
}

function assertMatchesFullScan(sim: TailSim): void {
  expect(indexedMayContainBlockedSignal(sim.lines, sim.partialLine)).toBe(
    referenceMayContainBlockedSignal(sim.lines, sim.partialLine)
  )
  expect(computeTerminalTailWaitState(sim.lines, sim.partialLine, sim.preview)).toEqual(
    computeTerminalTailWaitState(unindexed(sim), sim.partialLine, sim.preview)
  )
}

const BLOCKED_LINE = 'Update available! Press Enter to continue.'
const ESC = String.fromCharCode(27)

/** The exact positions a from-scratch scan would record, written out independently. */
function referenceSentinelMatches(lines: readonly string[]): number[] {
  const matches: number[] = []
  for (let index = 0; index < lines.length; index += 1) {
    if (TERMINAL_WAIT_BLOCKED_SENTINEL_RE.test(lines[index]!)) {
      matches.push(index)
    }
  }
  return matches
}

/**
 * The whole contract of the carried window, at position resolution: the index the constructor
 * registered for this exact array must equal a from-scratch scan of it. A boolean-only assertion
 * would pass on an index whose positions are shifted, doubled, or out of bounds.
 */
function assertIndexedPositionsAreExact(lines: readonly string[]): void {
  const indexed = [...getTerminalTailSentinelMatches(lines)]
  expect(indexed).toEqual(referenceSentinelMatches(lines))
  for (const position of indexed) {
    expect(position).toBeGreaterThanOrEqual(0)
    expect(position).toBeLessThan(lines.length)
  }
}

function countSentinelTests(run: () => void): number {
  const spy = vi.spyOn(TERMINAL_WAIT_BLOCKED_SENTINEL_RE, 'test')
  try {
    run()
    return spy.mock.calls.length
  } finally {
    spy.mockRestore()
  }
}

function saturatedSim(): TailSim {
  const sim = newSim()
  for (let index = 0; index < MAX_TAIL_LINES + 400; index += 1) {
    feed(sim, `streaming build output line ${index}\n`)
  }
  expect(sim.lines.length).toBe(MAX_TAIL_LINES)
  return sim
}

describe('terminal tail sentinel index', () => {
  it('tests only the lines an append produced, not the whole retained tail', () => {
    const sim = saturatedSim()
    // Warm the index for the current tail identity.
    computeTerminalTailWaitState(sim.lines, sim.partialLine, sim.preview)

    const incrementalTests = countSentinelTests(() => {
      for (let index = 0; index < 20; index += 1) {
        feed(sim, `fresh line ${index}\n`)
      }
      computeTerminalTailWaitState(sim.lines, sim.partialLine, sim.preview)
    })

    const fullScanTests = countSentinelTests(() => {
      computeTerminalTailWaitState(unindexed(sim), sim.partialLine, sim.preview)
    })

    expect(fullScanTests).toBeGreaterThanOrEqual(MAX_TAIL_LINES)
    // 20 appended lines + one partial-line test per compute call.
    expect(incrementalTests).toBeLessThanOrEqual(25)
  })

  it('keeps a retained sentinel visible and drops it exactly when it is evicted', () => {
    const sim = saturatedSim()
    feed(sim, `${BLOCKED_LINE}\n`)
    expect(indexedMayContainBlockedSignal(sim.lines, sim.partialLine)).toBe(true)
    assertMatchesFullScan(sim)

    // Push the prompt to the very last retained slot.
    for (let index = 0; index < MAX_TAIL_LINES - 1; index += 1) {
      feed(sim, `after prompt ${index}\n`)
      expect(indexedMayContainBlockedSignal(sim.lines, sim.partialLine)).toBe(true)
    }
    expect(sim.lines[0]).toBe(BLOCKED_LINE)

    // One more line evicts it.
    feed(sim, 'evicting line\n')
    expect(sim.lines.includes(BLOCKED_LINE)).toBe(false)
    expect(indexedMayContainBlockedSignal(sim.lines, sim.partialLine)).toBe(false)
    assertMatchesFullScan(sim)

    // And it stays gone many chunks later.
    for (let index = 0; index < 200; index += 1) {
      feed(sim, `long after eviction ${index}\n`)
    }
    expect(indexedMayContainBlockedSignal(sim.lines, sim.partialLine)).toBe(false)
    assertMatchesFullScan(sim)
  })

  it('drops a sentinel evicted by the retained-character cap', () => {
    const sim = newSim()
    feed(sim, `${BLOCKED_LINE}\n`)
    expect(indexedMayContainBlockedSignal(sim.lines, sim.partialLine)).toBe(true)
    const bulkLine = `${'x'.repeat(4000)}\n`
    for (let index = 0; index * 4001 < MAX_TAIL_CHARS + 20000; index += 1) {
      feed(sim, bulkLine)
    }
    expect(sim.lines.includes(BLOCKED_LINE)).toBe(false)
    expect(indexedMayContainBlockedSignal(sim.lines, sim.partialLine)).toBe(false)
    assertMatchesFullScan(sim)
  })

  it('finds a sentinel split across two chunks once the line completes', () => {
    const sim = saturatedSim()
    feed(sim, 'Codex asks: press ent')
    // Still only a partial line, and no alternative matches the fragment yet.
    expect(indexedMayContainBlockedSignal(sim.lines, sim.partialLine)).toBe(false)
    assertMatchesFullScan(sim)

    feed(sim, 'er to confirm')
    // Now complete, but still the partial line — the partial is always tested directly.
    expect(indexedMayContainBlockedSignal(sim.lines, sim.partialLine)).toBe(true)
    assertMatchesFullScan(sim)

    feed(sim, '\n')
    // And once it becomes a retained line the index carries it.
    expect(sim.partialLine).toBe('')
    expect(indexedMayContainBlockedSignal(sim.lines, sim.partialLine)).toBe(true)
    assertMatchesFullScan(sim)
  })

  it('full-scans a tail array the index has never seen (seed/restore path)', () => {
    // primeWaitBlockedBaselineFromSeededTail reads whatever tail the restore seed installed.
    const seeded = ['boot log', BLOCKED_LINE, 'trailing']
    expect(tailMayContainBlockedSignal(seeded)).toBe(true)
    const state = computeTerminalTailWaitState(seeded, '', '')
    expect(state.fromTail).toBe(true)
    expect(state.signal?.reason).toBe('codex-update-prompt')

    const clean = ['boot log', 'no prompt here', 'trailing']
    expect(tailMayContainBlockedSignal(clean)).toBe(false)
    expect(computeTerminalTailWaitState(clean, '', '').signal).toBeNull()
  })

  it('reports fromTail from a blank tail without consulting the index', () => {
    const sim = newSim()
    feed(sim, '   \n\t\n')
    expect(computeTerminalTailWaitState(sim.lines, sim.partialLine, '').fromTail).toBe(false)
    feed(sim, 'now visible\n')
    expect(computeTerminalTailWaitState(sim.lines, sim.partialLine, '').fromTail).toBe(true)
  })
})

/**
 * `buildCarriedTailLines` is the only producer of a tail array, and it derives the carried-match
 * window from the same keep bounds it slices the array out of. These guards pin the four ways
 * that derivation could still be written wrong, plus the one way a path could escape it. Each was
 * confirmed to fail against a deliberately broken constructor (see the PR body).
 */
describe('terminal tail sentinel index carried window', () => {
  it('drops a carried match the moment the constructor evicts its row (no stale match)', () => {
    const sim = saturatedSim()
    feed(sim, `${BLOCKED_LINE}\n`)
    // Walk it to the very first retained slot, checking the position every step: each append
    // evicts one row at a saturated tail, so the carried match must shift down by exactly one.
    for (let index = 0; index < MAX_TAIL_LINES - 1; index += 1) {
      feed(sim, `after prompt ${index}\n`)
      expect(getTerminalTailSentinelMatches(sim.lines)).toEqual([MAX_TAIL_LINES - 2 - index])
    }
    expect(sim.lines[0]).toBe(BLOCKED_LINE)

    feed(sim, 'evicting line\n')
    expect(sim.lines.includes(BLOCKED_LINE)).toBe(false)
    assertIndexedPositionsAreExact(sim.lines)
    expect(indexedMayContainBlockedSignal(sim.lines, sim.partialLine)).toBe(false)
  })

  it('finds a match a redraw writes into rows the carried prefix does not cover', () => {
    const sim = saturatedSim()
    expect(indexedMayContainBlockedSignal(sim.lines, sim.partialLine)).toBe(false)

    // A windowed redraw: the prefix carries, the rewritten suffix must still be scanned.
    feed(sim, `${ESC}[3A${ESC}[2K${BLOCKED_LINE}\n`)
    assertIndexedPositionsAreExact(sim.lines)
    expect(indexedMayContainBlockedSignal(sim.lines, sim.partialLine)).toBe(true)

    // And a redraw that overwrites that same row again must drop it.
    feed(sim, `${ESC}[1A${ESC}[2Kplain replacement\n`)
    assertIndexedPositionsAreExact(sim.lines)

    // A redraw deep enough to outrun the window carries nothing and rescans in full.
    feed(sim, `${ESC}[2500A${ESC}[2K${BLOCKED_LINE}\n`)
    assertIndexedPositionsAreExact(sim.lines)
    expect(indexedMayContainBlockedSignal(sim.lines, sim.partialLine)).toBe(true)
  })

  it('shifts every carried position by exactly the number of rows evicted', () => {
    const sim = newSim()
    feed(sim, `first\n${BLOCKED_LINE}\nsecond\n${BLOCKED_LINE}\nthird\n`)
    expect(getTerminalTailSentinelMatches(sim.lines)).toEqual([1, 3])

    // Saturate so the line cap evicts exactly one row per single-line append.
    for (let index = 0; index < MAX_TAIL_LINES - 5; index += 1) {
      feed(sim, `pad ${index}\n`)
    }
    expect(sim.lines.length).toBe(MAX_TAIL_LINES)
    expect(getTerminalTailSentinelMatches(sim.lines)).toEqual([1, 3])

    feed(sim, 'evict one\n')
    expect(getTerminalTailSentinelMatches(sim.lines)).toEqual([0, 2])
    feed(sim, 'evict two\n')
    expect(getTerminalTailSentinelMatches(sim.lines)).toEqual([1])
    assertIndexedPositionsAreExact(sim.lines)
  })

  it('stays in bounds when a single chunk evicts the whole carried window and part of itself', () => {
    const sim = saturatedSim()
    feed(sim, `${BLOCKED_LINE}\n`)
    expect(indexedMayContainBlockedSignal(sim.lines, sim.partialLine)).toBe(true)

    // One chunk with more complete lines than the tail retains: every carried row goes, and so
    // does the front of the chunk itself, so nothing may survive from before the cut.
    const early: string[] = [BLOCKED_LINE]
    for (let index = 0; index < MAX_TAIL_LINES + 500; index += 1) {
      early.push(`flood ${index}`)
    }
    feed(sim, `${early.join('\n')}\n`)
    expect(sim.lines.length).toBe(MAX_TAIL_LINES)
    assertIndexedPositionsAreExact(sim.lines)
    expect(indexedMayContainBlockedSignal(sim.lines, sim.partialLine)).toBe(false)

    // Same shape, but the prompt lands inside the surviving suffix of the chunk.
    const late: string[] = []
    for (let index = 0; index < MAX_TAIL_LINES + 500; index += 1) {
      late.push(`flood ${index}`)
    }
    late.push(BLOCKED_LINE)
    feed(sim, `${late.join('\n')}\n`)
    expect(getTerminalTailSentinelMatches(sim.lines)).toEqual([MAX_TAIL_LINES - 1])
    assertIndexedPositionsAreExact(sim.lines)

    // The character cap drops from the same front, past the carried window and into the chunk.
    const bulk = `${'x'.repeat(4000)}\n`
    for (let index = 0; index * 4001 < MAX_TAIL_CHARS + 20000; index += 1) {
      feed(sim, bulk)
    }
    assertIndexedPositionsAreExact(sim.lines)
    expect(indexedMayContainBlockedSignal(sim.lines, sim.partialLine)).toBe(false)
  })

  it('never leaves a produced tail unindexed, on any append path', () => {
    const sim = saturatedSim()
    computeTerminalTailWaitState(sim.lines, sim.partialLine, sim.preview)
    const fullScansBefore = getTerminalTailSentinelFullScanCount()

    feed(sim, `${BLOCKED_LINE}\n`)
    for (let index = 0; index < 200; index += 1) {
      feed(sim, `after prompt ${index}\n`)
    }
    feed(sim, 'partial with no newline')
    feed(sim, ' and its completion\n')
    feed(sim, '\rspinner 40%')
    feed(sim, `${ESC}[3A${ESC}[2Kredrawn\n`)
    feed(sim, `${ESC}[2500A${ESC}[2Kdeep redraw\n`)
    feed(sim, 'trailing spaces here   \n')
    feed(sim, `${'z'.repeat(5000)}\n`)
    feed(sim, `multi\nline\nchunk\n`)
    feed(sim, '')
    // Reading the verdict must never trigger a scan of an array the constructor produced.
    computeTerminalTailWaitState(sim.lines, sim.partialLine, sim.preview)

    expect(getTerminalTailSentinelFullScanCount()).toBe(fullScansBefore)
    assertIndexedPositionsAreExact(sim.lines)
  })
})

// Deterministic PRNG so a divergence is reproducible from the seed alone.
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * `streaming` saturates and evicts the retained tail; `tui` trades saturation for redraw
 * coverage (cursor-up rewrites of retained rows, and reaches past the redraw window).
 */
function randomChunk(random: () => number, profile: 'streaming' | 'tui'): string {
  const roll = random()
  if (roll < 0.2) {
    const lines: string[] = []
    for (let index = 0; index < 30; index += 1) {
      lines.push(`burst line ${Math.floor(random() * 1e6)}`)
    }
    return `${lines.join('\n')}\n`
  }
  if (roll < 0.42) {
    return `plain output ${Math.floor(random() * 1e6)}\n`
  }
  if (roll < 0.48) {
    return `${'   '.repeat(Math.floor(random() * 3))}\n`
  }
  if (roll < 0.54) {
    return `${BLOCKED_LINE}\n`
  }
  if (roll < 0.58) {
    return 'do you trust the files in this folder?\n'
  }
  if (roll < 0.63) {
    // Sentinel split across a chunk boundary.
    return random() < 0.5 ? 'Codex asks: press ent' : 'er to confirm\n'
  }
  if (roll < 0.7) {
    // TUI redraw: move the cursor up a few rows and rewrite them.
    const rows = 1 + Math.floor(random() * 12)
    return `${ESC}[${rows}A${ESC}[2Kredrawn row ${Math.floor(random() * 1000)}\n`
  }
  if (roll < (profile === 'tui' ? 0.76 : 0.7)) {
    // Deep redraw that outruns the window and forces the unwindowed path.
    return `${ESC}[${1500 + Math.floor(random() * 800)}A${ESC}[2Kdeep redraw\n`
  }
  if (roll < 0.82) {
    return `\rspinner ${Math.floor(random() * 100)}%`
  }
  if (roll < 0.87) {
    return 'trailing spaces here   \n'
  }
  if (roll < 0.91) {
    return `${'y'.repeat(3000)}\n`
  }
  if (roll < 0.95) {
    return `multi\nline\nchunk ${Math.floor(random() * 1000)}\n`
  }
  if (roll < 0.97) {
    return ''
  }
  return `no newline ${Math.floor(random() * 1000)}`
}

describe('terminal tail sentinel index property', () => {
  for (const profile of ['streaming', 'tui'] as const) {
    for (const seed of [1, 7, 42, 1337]) {
      it(`matches a full scan on every step of a random ${profile} sequence (seed ${seed})`, () => {
        const random = mulberry32(seed)
        const sim = newSim()
        let sawSentinel = false
        let sawSaturation = false
        for (let step = 0; step < 1200; step += 1) {
          feed(sim, randomChunk(random, profile))
          const expected = referenceMayContainBlockedSignal(sim.lines, sim.partialLine)
          expect(indexedMayContainBlockedSignal(sim.lines, sim.partialLine)).toBe(expected)
          expect(computeTerminalTailWaitState(sim.lines, sim.partialLine, sim.preview)).toEqual(
            computeTerminalTailWaitState(unindexed(sim), sim.partialLine, sim.preview)
          )
          sawSentinel = sawSentinel || expected
          sawSaturation = sawSaturation || sim.lines.length >= MAX_TAIL_LINES
        }
        // Guard against a vacuous pass.
        expect(sawSentinel).toBe(true)
        if (profile === 'streaming') {
          expect(sawSaturation).toBe(true)
        }
      })
    }
  }
})
