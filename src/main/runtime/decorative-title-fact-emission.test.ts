import { describe, expect, it } from 'vitest'
import {
  DECORATIVE_TITLE_FACT_HEARTBEAT_MS,
  shouldEmitTitleFactForFrame
} from './decorative-title-fact-emission'

const base = {
  decorativeOnly: true,
  staleWorkingTitleClear: false,
  lastEmittedAtMs: 1_000,
  nowMs: 1_000
}

// Orca's synthetic agent spinner re-emits a semantically identical title at this cadence.
const SPINNER_INTERVAL_MS = 80
const HOOK_DONE_QUIET_MS = 1_500

/** When a pane whose underlying title never changes actually emits, over `spanMs`. */
function decorativeEmissionSchedule(tickMs: number, spanMs: number): number[] {
  const emitted: number[] = []
  let lastEmittedAtMs: number | null = null
  for (let nowMs = 0; nowMs < spanMs; nowMs += tickMs) {
    if (shouldEmitTitleFactForFrame({ ...base, lastEmittedAtMs, nowMs })) {
      emitted.push(nowMs)
      lastEmittedAtMs = nowMs
    }
  }
  return emitted
}

function uniqueSpacings(emitted: number[]): number[] {
  return [...new Set(emitted.slice(1).map((at, index) => at - emitted[index]))]
}

/** Fewest frames any HOOK_DONE_QUIET_MS window sees — the number the cancel actually depends on. */
function minFramesPerQuietWindow(emitted: number[], spanMs: number): number {
  let fewest = Number.POSITIVE_INFINITY
  for (let start = 0; start + HOOK_DONE_QUIET_MS <= spanMs; start += 1) {
    const inWindow = emitted.filter((at) => at > start && at <= start + HOOK_DONE_QUIET_MS).length
    fewest = Math.min(fewest, inWindow)
  }
  return fewest
}

describe('shouldEmitTitleFactForFrame', () => {
  it('always emits a frame that is not a decorative repeat', () => {
    expect(shouldEmitTitleFactForFrame({ ...base, decorativeOnly: false })).toBe(true)
  })

  it('emits the first frame of a pane', () => {
    expect(shouldEmitTitleFactForFrame({ ...base, lastEmittedAtMs: null })).toBe(true)
  })

  it('suppresses a decorative repeat inside the heartbeat window', () => {
    expect(
      shouldEmitTitleFactForFrame({
        ...base,
        nowMs: 1_000 + DECORATIVE_TITLE_FACT_HEARTBEAT_MS - 1
      })
    ).toBe(false)
  })

  it('lets a decorative repeat through once the heartbeat window elapses', () => {
    expect(
      shouldEmitTitleFactForFrame({ ...base, nowMs: 1_000 + DECORATIVE_TITLE_FACT_HEARTBEAT_MS })
    ).toBe(true)
  })

  it('never throttles a timer-synthesized stale-working clear', () => {
    // Why: it carries a staleWorkingTitleClear flag no earlier repeat can stand in for.
    expect(shouldEmitTitleFactForFrame({ ...base, staleWorkingTitleClear: true })).toBe(true)
  })

  it('emits after a backwards clock step instead of parking until it catches up', () => {
    expect(shouldEmitTitleFactForFrame({ ...base, nowMs: 900 })).toBe(true)
  })

  it('leaves a working frame inside every hook-done quiet window at the spinner tick rate', () => {
    // Why the realised schedule and not the constant: emission lands on the first tick at or past
    // each heartbeat boundary, so real spacing is 560ms, not DECORATIVE_TITLE_FACT_HEARTBEAT_MS.
    // observeTitle's arriving working title is what cancels a Pi/OMP milestone `done` parked for
    // HOOK_DONE_QUIET_MS, so one frame per window is the requirement; this cadence gives two.
    const spanMs = 10_000
    const emitted = decorativeEmissionSchedule(SPINNER_INTERVAL_MS, spanMs)

    // The invariant the cancel depends on: no quiet window may ever come up empty.
    expect(minFramesPerQuietWindow(emitted, spanMs)).toBeGreaterThanOrEqual(1)
    // The realised floor and cadence at today's constants, so a retune shows its true cost.
    expect(minFramesPerQuietWindow(emitted, spanMs)).toBe(2)
    expect(uniqueSpacings(emitted)).toEqual([560])
    expect(emitted.length).toBe(18)
  })
})
