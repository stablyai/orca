import { describe, expect, it } from 'vitest'
import { evaluateTuiIdle } from './tui-idle-evidence'
import type { TuiIdleHookTurn } from './tui-idle-hook-lane'

function settle(hook: TuiIdleHookTurn | null, screenLooksReady: boolean) {
  let screenReads = 0
  const verdict = evaluateTuiIdle({
    record: { lastAgentStatus: null, lastOutputAt: null },
    readTailBlockedReason: () => null,
    readPositiveBodyEvidence: () => {
      screenReads += 1
      return screenLooksReady
    },
    readQuietReadyBodyEvidence: () => false,
    readAgentRuleVerdict: () => null,
    readScreenInputVeto: () => false,
    titleObservedAtEpochMs: null,
    agent: 'hermes',
    firstPartyStatus: null,
    readHookTurn: () => hook,
    quiescenceMs: 1_000
  })
  return { verdict, screenReads }
}

describe('Hermes hook authority', () => {
  it('keeps a working hook ahead of a ready-looking screen', () => {
    const { verdict, screenReads } = settle({ state: 'working', blockedReason: null }, true)

    expect(verdict).toEqual({ kind: 'working' })
    expect(screenReads).toBe(0)
  })

  it('uses the screen when Hermes has no hook row', () => {
    expect(settle(null, true).verdict).toEqual({ kind: 'ready-strong' })
  })
})
