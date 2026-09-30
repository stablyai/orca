import { describe, expect, it } from 'vitest'
import { AgentPromptRequestCorrelation } from './agent-prompt-request-correlation'

const PTY = 'pty-1'
const GENERATION = 1

function lifecycle(workingSequence: number) {
  return { kind: 'lifecycle' as const, workingSequence }
}

function register(
  correlation: AgentPromptRequestCorrelation,
  requestId: string,
  baselineWorkingSequence: number
): void {
  correlation.register(PTY, {
    generation: GENERATION,
    requestId,
    baselineWorkingSequence,
    baselineExplicitWorkingStartedAt: null
  })
}

describe('agent prompt request correlation', () => {
  it('gives one lifecycle transition to exactly one queued request', () => {
    const correlation = new AgentPromptRequestCorrelation()
    register(correlation, 'first', 0)
    register(correlation, 'second', 0)

    expect(correlation.acceptTurnStart(PTY, GENERATION, 'first', 0, null, lifecycle(1))).toBe(true)
    expect(correlation.acceptTurnStart(PTY, GENERATION, 'second', 0, null, lifecycle(1))).toBe(
      false
    )
    expect(correlation.acceptTurnStart(PTY, GENERATION, 'second', 0, null, lifecycle(2))).toBe(true)
  })

  it('still allocates a later request when an earlier one has no free sequence', () => {
    const correlation = new AgentPromptRequestCorrelation()
    register(correlation, 'owner-of-6', 5)
    expect(correlation.acceptTurnStart(PTY, GENERATION, 'owner-of-6', 5, null, lifecycle(6))).toBe(
      true
    )

    // `late` can only take sequence 6, which is taken; `early` can still take 3.
    register(correlation, 'late', 5)
    register(correlation, 'early', 2)
    expect(correlation.acceptTurnStart(PTY, GENERATION, 'early', 2, null, lifecycle(6))).toBe(true)
    expect(correlation.acceptTurnStart(PTY, GENERATION, 'late', 5, null, lifecycle(6))).toBe(false)
  })

  it('reserves a hook turn start for the oldest eligible request', () => {
    const correlation = new AgentPromptRequestCorrelation()
    register(correlation, 'oldest', 0)
    register(correlation, 'newest', 0)
    const hook = { kind: 'hook' as const, workingStartedAt: 500 }

    expect(correlation.acceptTurnStart(PTY, GENERATION, 'newest', 0, null, hook)).toBe(false)
    expect(correlation.acceptTurnStart(PTY, GENERATION, 'oldest', 0, null, hook)).toBe(true)
    expect(correlation.acceptTurnStart(PTY, GENERATION, 'newest', 0, null, hook)).toBe(false)
  })

  it('refuses a request the PTY no longer holds', () => {
    const correlation = new AgentPromptRequestCorrelation()
    register(correlation, 'cleared', 0)
    correlation.clearForPty(PTY)

    expect(correlation.acceptTurnStart(PTY, GENERATION, 'cleared', 0, null, lifecycle(1))).toBe(
      false
    )
  })

  it('scopes claims to the generation that recorded them', () => {
    const correlation = new AgentPromptRequestCorrelation()
    register(correlation, 'gen-1', 0)
    correlation.register(PTY, {
      generation: 2,
      requestId: 'gen-2',
      baselineWorkingSequence: 0,
      baselineExplicitWorkingStartedAt: null
    })

    expect(correlation.acceptTurnStart(PTY, GENERATION, 'gen-1', 0, null, lifecycle(1))).toBe(true)
    expect(correlation.acceptTurnStart(PTY, 2, 'gen-2', 0, null, lifecycle(1))).toBe(true)
  })
})
