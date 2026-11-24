import { describe, expect, it } from 'vitest'
import { appendNormalizedToTailBuffer } from './terminal-tail-buffer'
import { MAX_TAIL_CHARS, MAX_TAIL_LINES } from './terminal-tail-limits'
import {
  getTerminalTailSentinelMatches,
  tailMayContainBlockedSignal
} from './terminal-tail-sentinel-index'
import type { RetainedTailRedrawCursor } from './terminal-tail-redraw-buffer'

type TailSim = {
  lines: string[]
  partialLine: string
  redrawCursor: RetainedTailRedrawCursor | null
}

function newSim(): TailSim {
  return { lines: [], partialLine: '', redrawCursor: null }
}

function feed(sim: TailSim, chunk: string): void {
  const next = appendNormalizedToTailBuffer(sim.lines, sim.partialLine, chunk, sim.redrawCursor)
  sim.lines = next.lines
  sim.partialLine = next.partialLine
  sim.redrawCursor = next.redrawCursor
}

const BLOCKED_LINE = 'Update available! Press Enter to continue.'
const ESC = String.fromCharCode(27)

function saturatedSim(): TailSim {
  const sim = newSim()
  for (let index = 0; index < MAX_TAIL_LINES + 400; index += 1) {
    feed(sim, `streaming build output line ${index}\n`)
  }
  expect(sim.lines.length).toBe(MAX_TAIL_LINES)
  return sim
}

describe('terminal tail sentinel index carried window', () => {
  it('finds a match a redraw writes into rows the carried prefix does not cover', () => {
    const sim = saturatedSim()
    expect(tailMayContainBlockedSignal(sim.lines)).toBe(false)

    // A windowed redraw: the prefix carries, the rewritten suffix must still be scanned.
    feed(sim, `${ESC}[3A${ESC}[2K${BLOCKED_LINE}\n`)
    expect(tailMayContainBlockedSignal(sim.lines)).toBe(true)

    // And a redraw that overwrites that same row again must drop it.
    feed(sim, `${ESC}[1A${ESC}[2Kplain replacement\n`)
    expect(tailMayContainBlockedSignal(sim.lines)).toBe(false)

    // A redraw deep enough to outrun the window carries nothing and rescans in full.
    feed(sim, `${ESC}[2500A${ESC}[2K${BLOCKED_LINE}\n`)
    expect(tailMayContainBlockedSignal(sim.lines)).toBe(true)
  })

  it('stays in bounds when a single chunk evicts the whole carried window and part of itself', () => {
    const sim = saturatedSim()
    feed(sim, `${BLOCKED_LINE}\n`)
    expect(tailMayContainBlockedSignal(sim.lines)).toBe(true)

    // An oversized chunk evicts every carried row and its own head; no match may survive before the cut.
    const early: string[] = [BLOCKED_LINE]
    for (let index = 0; index < MAX_TAIL_LINES + 500; index += 1) {
      early.push(`flood ${index}`)
    }
    feed(sim, `${early.join('\n')}\n`)
    expect(sim.lines.length).toBe(MAX_TAIL_LINES)
    expect(tailMayContainBlockedSignal(sim.lines)).toBe(false)

    // Same shape, but the prompt lands inside the surviving suffix of the chunk.
    const late: string[] = []
    for (let index = 0; index < MAX_TAIL_LINES + 500; index += 1) {
      late.push(`flood ${index}`)
    }
    late.push(BLOCKED_LINE)
    feed(sim, `${late.join('\n')}\n`)
    expect(getTerminalTailSentinelMatches(sim.lines)).toEqual([MAX_TAIL_LINES - 1])

    // The character cap drops from the same front, past the carried window and into the chunk.
    const bulk = `${'x'.repeat(4000)}\n`
    for (let index = 0; index * 4001 < MAX_TAIL_CHARS + 20000; index += 1) {
      feed(sim, bulk)
    }
    expect(tailMayContainBlockedSignal(sim.lines)).toBe(false)
  })
})
