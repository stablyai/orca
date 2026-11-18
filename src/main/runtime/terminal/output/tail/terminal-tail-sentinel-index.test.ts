import { describe, expect, it, vi } from 'vitest'
import { appendNormalizedToTailBuffer } from './terminal-tail-buffer'
import { MAX_TAIL_CHARS, MAX_TAIL_LINES } from './terminal-tail-limits'
import { buildPreview } from './terminal-tail-state'
import {
  getTerminalTailSentinelMatches,
  tailMayContainBlockedSignal
} from './terminal-tail-sentinel-index'
import { computeTerminalTailWaitState } from '../../wait/terminal-wait-tail-state'
import { terminalWaitBlockedSentinelRe } from '../../../agent-state-rules/blocked-text-layer'
import type { RetainedTailRedrawCursor } from './terminal-tail-redraw-buffer'

// Independent full scan defines whether any retained/partial line matches the blocked sentinel.

function indexedMayContainBlockedSignal(lines: string[], partialLine: string): boolean {
  return tailMayContainBlockedSignal(lines) || terminalWaitBlockedSentinelRe().test(partialLine)
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

const BLOCKED_LINE = 'Update available! Press Enter to continue.'
const ESC = String.fromCharCode(27)

/** The exact positions a from-scratch scan would record, written out independently. */
function referenceSentinelMatches(lines: readonly string[]): number[] {
  const matches: number[] = []
  for (let index = 0; index < lines.length; index += 1) {
    if (terminalWaitBlockedSentinelRe().test(lines[index]!)) {
      matches.push(index)
    }
  }
  return matches
}

/** Compare exact match positions against a fresh scan; booleans cannot catch shifted, duplicate or out-of-bounds indices. */
function assertIndexedPositionsAreExact(lines: readonly string[]): void {
  const indexed = [...getTerminalTailSentinelMatches(lines)]
  expect(indexed).toEqual(referenceSentinelMatches(lines))
  for (const position of indexed) {
    expect(position).toBeGreaterThanOrEqual(0)
    expect(position).toBeLessThan(lines.length)
  }
}

function countSentinelTests(run: () => void): number {
  const spy = vi.spyOn(terminalWaitBlockedSentinelRe(), 'test')
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
})

// Compare constructor carry windows with independent scans; boolean-only checks miss shifted, duplicated or out-of-bounds positions.
describe('terminal tail sentinel index carried window', () => {
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

  it('stays in bounds when a single chunk evicts the whole carried window and part of itself', () => {
    const sim = saturatedSim()
    feed(sim, `${BLOCKED_LINE}\n`)
    expect(indexedMayContainBlockedSignal(sim.lines, sim.partialLine)).toBe(true)

    // An oversized chunk evicts every carried row and its own head; no match may survive before the cut.
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
})

// Deterministic PRNG so a divergence is reproducible from the seed alone.

/**
 * `streaming` saturates and evicts the retained tail; `tui` trades saturation for redraw
 * coverage (cursor-up rewrites of retained rows, and reaches past the redraw window).
 */
