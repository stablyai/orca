import { expect, it } from 'vitest'
import { createUsageEventAggregation } from './usage-event-aggregation'
import type { UsageAttributedEventFields } from './usage-rollup-records'

type Event = UsageAttributedEventFields & { cost: number }
const aggregation = createUsageEventAggregation<Event, { cost: number }>({
  metric: {
    empty: () => ({ cost: 0 }),
    fromEvent: (event) => ({ cost: event.cost }),
    fold: (target, source) => {
      target.cost += source.cost
    }
  },
  cloneSessionForMerge: (session) => structuredClone(session)
})

function events(count: number): Event[] {
  return Array.from({ length: count }, (_, index) => ({
    sessionId: 'session',
    timestamp: '2026-09-07T00:00:00Z',
    day: '2026-09-07',
    model: `model-${index % 5}`,
    projectKey: `path-${index}`,
    projectLabel: `Path ${index}`,
    repoId: null,
    worktreeId: null,
    inputTokens: 1,
    cachedInputTokens: 0,
    outputTokens: 2,
    reasoningOutputTokens: 0,
    totalTokens: 3,
    cost: 0.5
  }))
}

// Index newly appended rows too or later sources append duplicate location/model entries.
it('folds later sources into rows the merge itself appended', () => {
  const [first] = events(1)
  first.projectKey = 'new-location'
  first.projectLabel = 'New location'
  first.model = 'new-model'
  const incoming = aggregation.aggregate([first]).sessions[0]
  const existingOnly = events(1)
  existingOnly[0].projectKey = 'other'
  const existing = aggregation.aggregate(existingOnly).sessions[0]
  aggregation.mergeSessions(new Map([['session', existing]]), [incoming, structuredClone(incoming)])
  const rows = existing.locationBreakdown.filter((entry) => entry.locationKey === 'new-location')
  expect(rows.map((entry) => entry.eventCount)).toEqual([2])
  const models = existing.modelBreakdown.filter((entry) => entry.modelKey === 'new-model')
  expect(models.map((entry) => entry.eventCount)).toEqual([2])
  const tuples = existing.locationModelBreakdown.filter(
    (entry) => entry.locationKey === 'new-location' && entry.modelKey === 'new-model'
  )
  expect(tuples.map((entry) => entry.eventCount)).toEqual([2])
})
