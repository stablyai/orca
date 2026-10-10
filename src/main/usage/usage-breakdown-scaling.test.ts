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

it('folds events without rescanning accumulated location breakdowns', () => {
  let reads = 0
  const input = events(1000)
  input.forEach((event, index) =>
    Object.defineProperty(event, 'projectKey', {
      get() {
        reads += 1
        return `path-${index}`
      }
    })
  )
  const result = aggregation.aggregate([...input, ...input])
  expect(reads).toBeLessThan(30000)
  const session = result.sessions[0]
  expect(session.totalTokens).toBe(6000)
  expect(session.cost).toBe(1000)
  expect(session.locationBreakdown).toHaveLength(1000)
  expect(session.locationBreakdown.every((entry) => entry.eventCount === 2)).toBe(true)
  expect(session.modelBreakdown).toHaveLength(5)
  expect(result.dailyAggregates).toHaveLength(1000)
})

it('folds streamed events immediately with the batch counters, metrics and metadata', () => {
  const [seed] = events(1)
  const first: Event = {
    ...seed,
    sessionId: 'mixed',
    timestamp: '2026-09-09T00:00:00Z',
    day: '2026-09-09',
    projectKey: 'z',
    projectLabel: 'Z',
    repoId: 'repo-z',
    worktreeId: 'tree-z',
    model: 'large',
    inputTokens: 3,
    cachedInputTokens: 1,
    outputTokens: 5,
    reasoningOutputTokens: 2,
    totalTokens: 8,
    cost: 2
  }
  const input: Event[] = [
    first,
    {
      ...seed,
      sessionId: 'unknown',
      timestamp: '2026-09-10T00:00:00Z',
      day: '2026-09-10',
      model: null
    },
    {
      ...first,
      timestamp: '2026-09-07T00:00:00Z',
      day: '2026-09-07',
      projectKey: 'a',
      projectLabel: 'A',
      repoId: 'repo-a',
      worktreeId: 'tree-a',
      model: 'small',
      inputTokens: 7,
      cachedInputTokens: 3,
      outputTokens: 11,
      reasoningOutputTokens: 5,
      totalTokens: 18,
      cost: 5
    },
    {
      ...first,
      timestamp: '2026-09-09T12:00:00Z',
      projectLabel: 'Changed label',
      repoId: 'changed-repo',
      worktreeId: 'changed-tree',
      inputTokens: 13,
      cachedInputTokens: 7,
      outputTokens: 17,
      reasoningOutputTokens: 11,
      totalTokens: 30,
      cost: 7
    }
  ]
  const expected = aggregation.aggregate(input)
  const accumulator = aggregation.createAccumulator()
  for (const event of input) {
    accumulator.add(event)
    event.totalTokens = 999
    event.cost = 999
    event.model = 'changed'
    event.projectLabel = 'Changed after adding'
  }
  const result = accumulator.finalize()
  expect(result).toEqual(expected)
  expect(result.sessions.map((session) => session.sessionId)).toEqual(['unknown', 'mixed'])
  expect(result.sessions[0].primaryModel).toBe('Unknown model')
  const mixed = result.sessions[1]
  expect(mixed).toMatchObject({
    firstTimestamp: '2026-09-07T00:00:00Z',
    lastTimestamp: '2026-09-09T12:00:00Z',
    primaryModel: 'Mixed models',
    hasMixedModels: true,
    primaryProjectLabel: 'Multiple locations',
    hasMixedLocations: true,
    primaryRepoId: 'repo-z',
    primaryWorktreeId: 'tree-z',
    eventCount: 3,
    totalInputTokens: 23,
    totalCachedInputTokens: 11,
    totalOutputTokens: 33,
    totalReasoningOutputTokens: 18,
    totalTokens: 56,
    cost: 14
  })
  expect(mixed.locationBreakdown).toMatchObject([
    { locationKey: 'z', projectLabel: 'Z', totalTokens: 38, cost: 9 },
    { locationKey: 'a', projectLabel: 'A', totalTokens: 18, cost: 5 }
  ])
  expect(mixed.modelBreakdown).toMatchObject([
    { modelKey: 'large', totalTokens: 38, cost: 9 },
    { modelKey: 'small', totalTokens: 18, cost: 5 }
  ])
  expect(mixed.locationModelBreakdown).toMatchObject([
    { locationKey: 'z', modelKey: 'large', totalTokens: 38, cost: 9 },
    { locationKey: 'a', modelKey: 'small', totalTokens: 18, cost: 5 }
  ])
  expect(result.dailyAggregates).toMatchObject([
    { day: '2026-09-07', projectKey: 'a', totalTokens: 18, cost: 5 },
    { day: '2026-09-09', projectKey: 'z', projectLabel: 'Z', totalTokens: 38, cost: 9 },
    { day: '2026-09-10', projectKey: 'path-0', totalTokens: 3, cost: 0.5 }
  ])
})

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

it('finalizes an empty stream once and rejects subsequent additions', () => {
  const accumulator = aggregation.createAccumulator()
  const result = accumulator.finalize()
  expect(result).toEqual({ sessions: [], dailyAggregates: [] })
  expect(accumulator.finalize()).toBe(result)
  expect(() => accumulator.add(events(1)[0])).toThrow('Cannot add usage events after finalization')
})

it('merges rollups using first-match indexes without mutating source breakdowns', () => {
  const source = aggregation.aggregate(events(1000)).sessions[0]
  const existing = structuredClone(source)
  let reads = 0
  for (const entry of [...existing.locationBreakdown, ...existing.locationModelBreakdown]) {
    const key = entry.locationKey
    Object.defineProperty(entry, 'locationKey', {
      get() {
        reads += 1
        return key
      }
    })
  }
  const target = new Map([['session', existing]])
  aggregation.mergeSessions(target, [source, source])
  expect(reads).toBeLessThan(10000)
  expect(existing.totalTokens).toBe(9000)
  expect(existing.cost).toBe(1500)
  expect(source.totalTokens).toBe(3000)
  expect(existing.locationBreakdown.every((entry) => entry.eventCount === 3)).toBe(true)
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

// Quotes and backslashes are the shapes a plain `::` separator would still collapse.
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

// The merge index must learn the rows it appends, or a second source carrying the same
// location/model would append a duplicate row instead of folding into the first.
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
