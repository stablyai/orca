import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalSideEffectBatch } from '../../../shared/terminal/output/terminal-side-effect-facts'
import { syncSinglePty } from '../orca-runtime-test-fixtures.spec'
import { createSideEffectRuntime } from '../orca-runtime-test-scenario-builders.spec'
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

  it('propagates a changed working label immediately even while the spinner rotates', () => {
    // Only spinner glyphs are decorative; Grok/Pi label churn changes content.
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
    // Mobile/remote read tracked records; suppressed facts must not freeze those snapshots.
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
