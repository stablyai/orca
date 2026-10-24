import { describe, expect, it } from 'vitest'
import type { AgentPromptActivity } from '../../agent-prompt-submission-verification'
import { launchPromptTurnStarted } from './launch-prompt-submit-retry'

const baseline: AgentPromptActivity = {
  generation: 1,
  permissionSequence: 0,
  workingSequence: 0,
  explicitWorkingStartedAt: null,
  outputSequence: 0,
  status: 'idle'
}

describe('launchPromptTurnStarted', () => {
  it.each([
    ['a title working edge', { workingSequence: 1 }],
    ['a hook working timestamp', { explicitWorkingStartedAt: 1_792_865_000_000 }],
    ['a status flip to working', { status: 'working' as const }]
  ])('accepts %s', (_label, current) => {
    expect(launchPromptTurnStarted(baseline, { ...baseline, ...current })).toBe(true)
  })

  it('does not accept a redraw while the agent stays idle', () => {
    expect(
      launchPromptTurnStarted(baseline, { ...baseline, outputSequence: 40, status: 'idle' })
    ).toBe(false)
  })

  it('does not accept a working status the baseline already had', () => {
    const working = { ...baseline, status: 'working' as const }
    expect(launchPromptTurnStarted(working, { ...working, workingSequence: 0 })).toBe(false)
  })
})
