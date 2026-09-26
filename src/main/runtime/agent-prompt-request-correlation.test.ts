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
    ...baseline(baselineWorkingSequence)
  })
}

function baseline(baselineWorkingSequence: number, baselinePromptAcceptedAt: number | null = null) {
  return {
    baselineWorkingSequence,
    baselineExplicitWorkingStartedAt: null,
    baselinePromptAcceptedAt
  }
}

describe('agent prompt request correlation', () => {
  it('gives one lifecycle transition to exactly one queued request', () => {
    const correlation = new AgentPromptRequestCorrelation()
    register(correlation, 'first', 0)
    register(correlation, 'second', 0)

    expect(correlation.acceptTurnStart(PTY, GENERATION, 'first', baseline(0), lifecycle(1))).toBe(
      true
    )
    expect(correlation.acceptTurnStart(PTY, GENERATION, 'second', baseline(0), lifecycle(1))).toBe(
      false
    )
    expect(correlation.acceptTurnStart(PTY, GENERATION, 'second', baseline(0), lifecycle(2))).toBe(
      true
    )
  })

  it('still allocates a later request when an earlier one has no free sequence', () => {
    const correlation = new AgentPromptRequestCorrelation()
    register(correlation, 'owner-of-6', 5)
    expect(
      correlation.acceptTurnStart(PTY, GENERATION, 'owner-of-6', baseline(5), lifecycle(6))
    ).toBe(true)

    // `late` can only take sequence 6, which is taken; `early` can still take 3.
    register(correlation, 'late', 5)
    register(correlation, 'early', 2)
    expect(correlation.acceptTurnStart(PTY, GENERATION, 'early', baseline(2), lifecycle(6))).toBe(
      true
    )
    expect(correlation.acceptTurnStart(PTY, GENERATION, 'late', baseline(5), lifecycle(6))).toBe(
      false
    )
  })

  it('reserves a hook turn start for the oldest eligible request', () => {
    const correlation = new AgentPromptRequestCorrelation()
    register(correlation, 'oldest', 0)
    register(correlation, 'newest', 0)
    const hook = { kind: 'hook' as const, workingStartedAt: 500 }

    expect(correlation.acceptTurnStart(PTY, GENERATION, 'newest', baseline(0), hook)).toBe(false)
    expect(correlation.acceptTurnStart(PTY, GENERATION, 'oldest', baseline(0), hook)).toBe(true)
    expect(correlation.acceptTurnStart(PTY, GENERATION, 'newest', baseline(0), hook)).toBe(false)
  })

  it('refuses a request the PTY no longer holds', () => {
    const correlation = new AgentPromptRequestCorrelation()
    register(correlation, 'cleared', 0)
    correlation.clearForPty(PTY)

    expect(correlation.acceptTurnStart(PTY, GENERATION, 'cleared', baseline(0), lifecycle(1))).toBe(
      false
    )
  })

  it('scopes claims to the generation that recorded them', () => {
    const correlation = new AgentPromptRequestCorrelation()
    register(correlation, 'gen-1', 0)
    correlation.register(PTY, {
      generation: 2,
      requestId: 'gen-2',
      ...baseline(0)
    })

    expect(correlation.acceptTurnStart(PTY, GENERATION, 'gen-1', baseline(0), lifecycle(1))).toBe(
      true
    )
    expect(correlation.acceptTurnStart(PTY, 2, 'gen-2', baseline(0), lifecycle(1))).toBe(true)
  })
  it('gives one prompt acceptance to the oldest request whose baseline predates it', () => {
    const correlation = new AgentPromptRequestCorrelation()
    correlation.register(PTY, { generation: GENERATION, requestId: 'older', ...baseline(0, 100) })
    correlation.register(PTY, { generation: GENERATION, requestId: 'newer', ...baseline(0, 100) })
    const accepted = { kind: 'accepted' as const, acceptedAt: 200 }

    expect(correlation.acceptTurnStart(PTY, GENERATION, 'newer', baseline(0, 100), accepted)).toBe(
      false
    )
    expect(correlation.acceptTurnStart(PTY, GENERATION, 'older', baseline(0, 100), accepted)).toBe(
      true
    )
    expect(correlation.acceptTurnStart(PTY, GENERATION, 'newer', baseline(0, 100), accepted)).toBe(
      false
    )
    // An acceptance the baseline already held is not this request's turn.
    expect(
      correlation.acceptTurnStart(PTY, GENERATION, 'newer', baseline(0, 100), {
        kind: 'accepted',
        acceptedAt: 100
      })
    ).toBe(false)
  })
})
