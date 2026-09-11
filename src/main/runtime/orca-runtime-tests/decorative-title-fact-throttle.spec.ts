import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalSideEffectBatch } from '../../../shared/terminal-side-effect-facts'
import { syncSinglePty } from '../orca-runtime-test-fixtures.spec'
import { createSideEffectRuntime } from '../orca-runtime-test-scenario-builders.spec'
import { DECORATIVE_TITLE_FACT_HEARTBEAT_MS } from '../decorative-title-fact-emission'

// Orca's own synthetic agent spinner: one frame per pane every 80ms while an agent works.
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const SPINNER_INTERVAL_MS = 80
const EPOCH = 1_700_000_000_000

type TitleFact = { kind: 'title'; normalizedTitle: string; rawTitle: string }

function titleFacts(batches: TerminalSideEffectBatch[]): TitleFact[] {
  return batches.flatMap((batch) =>
    batch.facts.filter((fact): fact is TitleFact => fact.kind === 'title')
  )
}

describe('decorative title fact throttle', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(EPOCH))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('collapses spinner ticks with an unchanged underlying title to the heartbeat rate', () => {
    const { runtime, batches } = createSideEffectRuntime()
    syncSinglePty(runtime)

    const ticks = 125 // 10s of Orca's 80ms synthetic spinner timer
    for (let tick = 0; tick < ticks; tick += 1) {
      vi.setSystemTime(new Date(EPOCH + tick * SPINNER_INTERVAL_MS))
      runtime.ingestSyntheticTitleFrame(
        'pty-1',
        `\x1b]0;${SPINNER_FRAMES[tick % SPINNER_FRAMES.length]} Claude Code\x07`
      )
    }

    const facts = titleFacts(batches)
    // Every frame carried the same underlying title, so the renderer learns nothing new past
    // the heartbeat: 125 pty:sideEffect messages collapse to one per heartbeat window.
    const elapsedMs = ticks * SPINNER_INTERVAL_MS
    expect(facts.length).toBeLessThanOrEqual(
      Math.ceil(elapsedMs / DECORATIVE_TITLE_FACT_HEARTBEAT_MS)
    )
    expect(facts.length).toBeLessThan(ticks / 5)
    // The heartbeat must not thin out below what the renderer's 1500ms hook-done quiet window
    // needs to cancel a milestone `done` — three working frames per window.
    expect(facts.length).toBeGreaterThanOrEqual(Math.floor(elapsedMs / 1_500) * 3)
    for (const fact of facts) {
      expect(fact.normalizedTitle.endsWith('Claude Code')).toBe(true)
    }
  })

  it('propagates a real title change on the tick it arrives, mid-heartbeat', () => {
    const { runtime, batches } = createSideEffectRuntime()
    syncSinglePty(runtime)

    runtime.ingestSyntheticTitleFrame('pty-1', '\x1b]0;⠋ Claude Code\x07')
    // Two more decorative ticks — still well inside the heartbeat window, so they are dropped.
    vi.setSystemTime(new Date(EPOCH + SPINNER_INTERVAL_MS))
    runtime.ingestSyntheticTitleFrame('pty-1', '\x1b]0;⠙ Claude Code\x07')
    vi.setSystemTime(new Date(EPOCH + 2 * SPINNER_INTERVAL_MS))
    runtime.ingestSyntheticTitleFrame('pty-1', '\x1b]0;⠹ Claude Code\x07')
    expect(titleFacts(batches)).toHaveLength(1)

    const beforeChange = batches.length
    vi.setSystemTime(new Date(EPOCH + 3 * SPINNER_INTERVAL_MS))
    runtime.ingestSyntheticTitleFrame('pty-1', '\x1b]0;✳ Claude Code\x07')

    expect(batches.length).toBeGreaterThan(beforeChange)
    expect(titleFacts(batches.slice(beforeChange))).toEqual([
      { kind: 'title', normalizedTitle: '✳ Claude Code', rawTitle: '✳ Claude Code' }
    ])
  })

  it('propagates a changed working label immediately even while the spinner rotates', () => {
    // Why: only the spinner glyph is decoration. Grok/Pi-style label churn is real content.
    const { runtime, batches } = createSideEffectRuntime()
    syncSinglePty(runtime)

    runtime.ingestSyntheticTitleFrame('pty-1', '\x1b]0;⠋ Claude Code\x07')
    vi.setSystemTime(new Date(EPOCH + SPINNER_INTERVAL_MS))
    runtime.ingestSyntheticTitleFrame('pty-1', '\x1b]0;⠙ Reviewing diff — Claude Code\x07')

    expect(titleFacts(batches).map((fact) => fact.rawTitle)).toEqual([
      '⠋ Claude Code',
      '⠙ Reviewing diff — Claude Code'
    ])
  })

  it('keeps main-side tracked title state current for every suppressed frame', () => {
    // Why: mobile/remote snapshots read the tracked record, not the fact stream — suppressing
    // the fact must not freeze what a phone or a paired client is shown.
    const { runtime } = createSideEffectRuntime()
    syncSinglePty(runtime)

    runtime.ingestSyntheticTitleFrame('pty-1', '\x1b]0;⠋ Claude Code\x07')
    vi.setSystemTime(new Date(EPOCH + SPINNER_INTERVAL_MS))
    runtime.ingestSyntheticTitleFrame('pty-1', '\x1b]0;⠙ Claude Code\x07')

    expect(runtime.getTerminalSideEffectSnapshot('pty-1')?.facts).toEqual([
      { kind: 'title', normalizedTitle: '⠙ Claude Code', rawTitle: '⠙ Claude Code' }
    ])
  })
})
