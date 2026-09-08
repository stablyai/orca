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

  it('keeps at least three frames inside the renderer hook-done quiet window', () => {
    // Why: observeTitle's arriving working title is what cancels a Pi/OMP milestone `done`
    // scheduled with HOOK_DONE_QUIET_MS = 1500. Losing that would mint a false completion.
    expect(DECORATIVE_TITLE_FACT_HEARTBEAT_MS * 3).toBeLessThanOrEqual(1_500)
  })
})
