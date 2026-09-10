import { describe, expect, it } from 'vitest'
import { unhandledProviderFrameJournalItem } from '../native-chat/agent-session-wire/unhandled-provider-frame'
import { codexGoalRowSignature, codexGoalRowText } from './codex-goal-journal-rows'

/** The shape a live Codex app-server session emits for `thread/goal/updated`. */
function goalFrame(overrides: { goal?: Record<string, unknown> } = {}): Record<string, unknown> {
  return {
    threadId: '01a08cc2-f96e-76d0-bb74-88b9bc0b03fc',
    turnId: '01a08cc2-fa6a-7541-a4c7-67d98a6e40c2',
    goal: {
      threadId: '01a08cc2-f96e-76d0-bb74-88b9bc0b03fc',
      objective: 'Keep the current scratch directory tidy.',
      status: 'active',
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1789067988,
      updatedAt: 1789067988,
      ...overrides.goal
    }
  }
}

describe('codexGoalRowText', () => {
  it('leads with the objective the goal actually carries', () => {
    expect(codexGoalRowText('thread/goal/updated', goalFrame())).toBe(
      'Goal set: Keep the current scratch directory tidy.'
    )
  })

  it.each([
    ['paused', 'Goal paused'],
    ['blocked', 'Goal blocked'],
    ['complete', 'Goal complete'],
    ['usageLimited', 'Goal stopped — usage limit'],
    ['budgetLimited', 'Goal stopped — token budget spent']
  ])('says what %s means rather than echoing the status', (status, prefix) => {
    expect(codexGoalRowText('thread/goal/updated', goalFrame({ goal: { status } }))).toBe(
      `${prefix}: Keep the current scratch directory tidy.`
    )
  })

  it('still says something true for a status this build does not know', () => {
    expect(
      codexGoalRowText('thread/goal/updated', goalFrame({ goal: { status: 'somethingNew' } }))
    ).toBe('Goal updated: Keep the current scratch directory tidy.')
  })

  it('reports a cleared goal, and ignores unrelated methods', () => {
    expect(codexGoalRowText('thread/goal/cleared', {})).toBe('Goal cleared')
    expect(codexGoalRowText('thread/tokenUsage/updated', goalFrame())).toBeNull()
  })

  it('falls back to the prefix alone when no objective survives', () => {
    expect(codexGoalRowText('thread/goal/updated', goalFrame({ goal: { objective: '   ' } }))).toBe(
      'Goal set'
    )
    expect(codexGoalRowText('thread/goal/updated', {})).toBe('Goal updated')
  })
})

describe('codexGoalRowSignature', () => {
  it('ignores the counters that climb on every turn', () => {
    // Two frames one live turn apart: only accounting moved.
    const first = codexGoalRowSignature('thread/goal/updated', goalFrame())
    const later = codexGoalRowSignature(
      'thread/goal/updated',
      goalFrame({ goal: { tokensUsed: 25999, timeUsedSeconds: 8, updatedAt: 1789067996 } })
    )
    expect(later).toBe(first)
  })

  it('separates a changed objective, status, or budget', () => {
    const base = codexGoalRowSignature('thread/goal/updated', goalFrame())
    expect(
      codexGoalRowSignature('thread/goal/updated', goalFrame({ goal: { status: 'complete' } }))
    ).not.toBe(base)
    expect(
      codexGoalRowSignature('thread/goal/updated', goalFrame({ goal: { objective: 'Ship it.' } }))
    ).not.toBe(base)
    expect(
      codexGoalRowSignature('thread/goal/updated', goalFrame({ goal: { tokenBudget: 50_000 } }))
    ).not.toBe(base)
  })

  it('has no signature for a frame that is not a goal', () => {
    expect(codexGoalRowSignature('thread/tokenUsage/updated', goalFrame())).toBeNull()
  })
})

describe('goal frames as journal rows', () => {
  it('journals the goal instead of dropping it as chrome', () => {
    const row = unhandledProviderFrameJournalItem(
      'codex',
      'notification:thread/goal/updated',
      goalFrame()
    )

    expect(row?.classification).toBe('timeline-substantive')
    expect(row?.body.text).toBe('Goal set: Keep the current scratch directory tidy.')
    // The raw frame stays available behind the row's disclosure.
    expect(row?.body.providerFrame?.kind).toBe('notification:thread/goal/updated')
  })

  it('journals a cleared goal', () => {
    const row = unhandledProviderFrameJournalItem('codex', 'notification:thread/goal/cleared', {
      threadId: '01a08cc2-f96e-76d0-bb74-88b9bc0b03fc'
    })

    expect(row?.body.text).toBe('Goal cleared')
  })

  it('never shows the bare opcode, which is what a plain reclassify would have done', () => {
    const row = unhandledProviderFrameJournalItem(
      'codex',
      'notification:thread/goal/updated',
      goalFrame()
    )

    expect(row?.body.text).not.toContain('notification:')
    expect(row?.body.text).not.toContain('codex · ')
  })
})
