import { describe, expect, it } from 'vitest'
import { createUsageEventAggregation } from './usage-event-aggregation'
import type { UsageAttributedEventFields } from './usage-rollup-records'

type Extra = { extra: number }

function event(
  overrides: Partial<UsageAttributedEventFields> & Pick<UsageAttributedEventFields, 'sessionId'>
): UsageAttributedEventFields {
  return {
    timestamp: '2026-05-26T12:00:00.000Z',
    model: 'gpt-5',
    day: '2026-05-26',
    projectKey: 'repo',
    projectLabel: 'repo',
    repoId: 'repo',
    worktreeId: 'wt',
    inputTokens: 1,
    cachedInputTokens: 0,
    outputTokens: 1,
    reasoningOutputTokens: 0,
    totalTokens: 2,
    ...overrides
  }
}

const aggregation = createUsageEventAggregation<UsageAttributedEventFields, Extra>({
  metric: {
    empty: () => ({ extra: 0 }),
    fromEvent: () => ({ extra: 1 }),
    fold: (target, source) => {
      target.extra += source.extra
    }
  },
  cloneSessionForMerge: (session) => ({
    ...session,
    locationBreakdown: [...session.locationBreakdown],
    modelBreakdown: [...session.modelBreakdown],
    locationModelBreakdown: [...session.locationModelBreakdown]
  })
})

describe('createUsageEventAggregation account attribution', () => {
  it('clears a session account when later events disagree', () => {
    const { sessions } = aggregation.aggregate([
      event({ sessionId: 'session-1', accountId: 'account-a' }),
      event({
        sessionId: 'session-1',
        accountId: 'account-b',
        timestamp: '2026-05-26T12:01:00.000Z'
      })
    ])

    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.accountId).toBeUndefined()
    expect(sessions[0]?.eventCount).toBe(2)
  })

  it('keeps a consistent session account', () => {
    const { sessions } = aggregation.aggregate([
      event({ sessionId: 'session-1', accountId: 'account-a' }),
      event({
        sessionId: 'session-1',
        accountId: 'account-a',
        timestamp: '2026-05-26T12:01:00.000Z'
      })
    ])

    expect(sessions[0]?.accountId).toBe('account-a')
  })
})
