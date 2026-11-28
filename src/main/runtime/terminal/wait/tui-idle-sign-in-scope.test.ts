import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  evaluateTuiIdle,
  PROGRAM_SIGN_IN_BLOCK_PERSIST_MS,
  type TuiIdleEvaluationInput
} from './tui-idle-evidence'

const FIXED_NOW = 1_700_000_000_000

function baseInput(overrides: Partial<TuiIdleEvaluationInput> = {}): TuiIdleEvaluationInput {
  return {
    record: { lastAgentStatus: null, lastOutputAt: FIXED_NOW, lastOscTitle: null },
    readTailBlockedReason: () => null,
    readPositiveBodyEvidence: () => false,
    readQuietReadyBodyEvidence: () => false,
    readAgentRuleVerdict: () => null,
    readScreenInputVeto: () => null,
    readProgramSignInWaitScreen: () => false,
    titleObservedAtEpochMs: null,
    agent: 'claude',
    firstPartyStatus: {
      state: 'blocked',
      updatedAt: FIXED_NOW,
      programSignInRequiredSince: FIXED_NOW - PROGRAM_SIGN_IN_BLOCK_PERSIST_MS - 100
    },
    quiescenceMs: 500,
    ...overrides
  }
}

describe('programSignInRequiredSince scoping', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(FIXED_NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fails fast with agent-sign-in-prompt for non-Antigravity agents without agy screen markers', () => {
    expect(evaluateTuiIdle(baseInput({ agent: 'claude' }))).toEqual({
      kind: 'blocked',
      reason: 'agent-sign-in-prompt'
    })
    expect(evaluateTuiIdle(baseInput({ agent: 'pi' }))).toEqual({
      kind: 'blocked',
      reason: 'agent-sign-in-prompt'
    })
  })

  it('holds Antigravity until its login menu screen is visible', () => {
    expect(
      evaluateTuiIdle(baseInput({ agent: 'antigravity', readProgramSignInWaitScreen: () => false }))
    ).toEqual({ kind: 'pending', quietForeground: 'closed' })
    expect(
      evaluateTuiIdle(baseInput({ agent: 'antigravity', readProgramSignInWaitScreen: () => true }))
    ).toEqual({ kind: 'blocked', reason: 'agent-sign-in-prompt' })
  })
})
