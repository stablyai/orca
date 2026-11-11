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

it('keeps first encounter order when streamed rollup sort keys tie', () => {
  const accumulator = aggregation.createAccumulator()
  for (const [index, event] of events(4).entries()) {
    accumulator.add({ ...event, sessionId: `session-${index % 2}`, projectLabel: 'Same label' })
  }
  const result = accumulator.finalize()
  expect(result.sessions.map((session) => session.sessionId)).toEqual(['session-0', 'session-1'])
  expect(result.sessions[0].locationBreakdown.map((entry) => entry.locationKey)).toEqual([
    'path-0',
    'path-2'
  ])
  expect(result.sessions[0].modelBreakdown.map((entry) => entry.modelKey)).toEqual([
    'model-0',
    'model-2'
  ])
  expect(result.dailyAggregates.map((entry) => entry.projectKey)).toEqual([
    'path-0',
    'path-1',
    'path-2',
    'path-3'
  ])
})

it('preserves first-wins duplicate rows and exact location/model tuple identity', () => {
  const source = aggregation.aggregate(events(1)).sessions[0]
  const existing = structuredClone(source)
  existing.locationBreakdown.push({ ...existing.locationBreakdown[0], eventCount: 42 })
  aggregation.mergeSessions(new Map([['session', existing]]), [source])
  expect(existing.locationBreakdown.map((entry) => entry.eventCount)).toEqual([2, 42])
  const input = events(2)
  input[0].projectKey = 'a::b'
  input[0].model = 'c'
  input[1].projectKey = 'a'
  input[1].model = 'b::c'
  expect(aggregation.aggregate(input).sessions[0].locationModelBreakdown).toHaveLength(2)
})

it('keeps location/model tuples distinct under quote and backslash keys', () => {
  const input = events(4)
  input[0].projectKey = 'a"'
  input[0].model = 'b'
  input[1].projectKey = 'a'
  input[1].model = '"b'
  input[2].projectKey = 'a\\'
  input[2].model = 'b'
  input[3].projectKey = 'a'
  input[3].model = '\\b'
  const session = aggregation.aggregate(input).sessions[0]
  expect(session.locationModelBreakdown).toHaveLength(4)
  expect(session.locationModelBreakdown.every((entry) => entry.eventCount === 1)).toBe(true)
})

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
