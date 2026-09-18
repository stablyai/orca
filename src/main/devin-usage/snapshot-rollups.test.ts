import { describe, expect, it } from 'vitest'
import {
  filterDailyAggregatesByScopeAndRange,
  filterSessionsByScopeAndRange,
  getScopedDevinSessionModels
} from './scope-range-filter'
import {
  buildDevinUsageBreakdownRows,
  buildDevinUsageRecentSessions,
  buildDevinUsageSummary
} from './snapshot-rollups'
import type {
  DevinUsageDailyAggregate,
  DevinUsageLocationBreakdown,
  DevinUsageLocationModelBreakdown,
  DevinUsageSession
} from './types'

function location(overrides: Partial<DevinUsageLocationBreakdown>): DevinUsageLocationBreakdown {
  return {
    locationKey: 'loc',
    projectLabel: 'proj',
    repoId: null,
    worktreeId: null,
    eventCount: 1,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: null,
    ...overrides
  }
}

function locationModel(
  overrides: Partial<DevinUsageLocationModelBreakdown>
): DevinUsageLocationModelBreakdown {
  return {
    locationKey: 'loc',
    modelKey: 'm1',
    modelLabel: 'M1',
    repoId: null,
    worktreeId: null,
    eventCount: 1,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: null,
    ...overrides
  }
}

function session(overrides: Partial<DevinUsageSession>): DevinUsageSession {
  return {
    sessionId: 's1',
    firstTimestamp: '2026-09-01T10:00:00Z',
    lastTimestamp: '2026-09-01T11:00:00Z',
    primaryModel: 'swe-2',
    hasMixedModels: false,
    primaryProjectLabel: 'proj',
    hasMixedLocations: false,
    primaryWorktreeId: null,
    primaryRepoId: null,
    eventCount: 0,
    totalInputTokens: 0,
    totalCachedInputTokens: 0,
    totalOutputTokens: 0,
    totalReasoningOutputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: null,
    locationBreakdown: [],
    modelBreakdown: [],
    locationModelBreakdown: [],
    ...overrides
  }
}

function daily(overrides: Partial<DevinUsageDailyAggregate>): DevinUsageDailyAggregate {
  return {
    day: '2026-09-01',
    model: 'swe-2',
    projectKey: 'pk',
    projectLabel: 'proj',
    repoId: null,
    worktreeId: null,
    eventCount: 1,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: null,
    ...overrides
  }
}

describe('filterSessionsByScopeAndRange', () => {
  it('keeps a mixed-location session under the orca scope', () => {
    const mixed = session({
      locationBreakdown: [
        location({ locationKey: 'a', worktreeId: 'w1' }),
        location({ locationKey: 'b', worktreeId: null })
      ]
    })
    expect(filterSessionsByScopeAndRange([mixed], 'orca', 'all')).toHaveLength(1)
  })

  it('drops sessions with no orca-attributed location', () => {
    const external = session({ locationBreakdown: [location({ worktreeId: null })] })
    expect(filterSessionsByScopeAndRange([external], 'orca', 'all')).toHaveLength(0)
    expect(filterSessionsByScopeAndRange([external], 'all', 'all')).toHaveLength(1)
  })

  it('applies the range cutoff to the session lastTimestamp', () => {
    const old = session({ lastTimestamp: '2020-01-01T00:00:00Z' })
    expect(filterSessionsByScopeAndRange([old], 'all', '7d')).toHaveLength(0)
    expect(filterSessionsByScopeAndRange([old], 'all', 'all')).toHaveLength(1)
  })
})

describe('filterDailyAggregatesByScopeAndRange', () => {
  it('drops rows without a worktree under the orca scope', () => {
    const rows = [daily({ worktreeId: 'w1' }), daily({ worktreeId: null })]
    const filtered = filterDailyAggregatesByScopeAndRange(rows, 'orca', 'all')
    expect(filtered).toHaveLength(1)
    expect(filtered[0].worktreeId).toBe('w1')
  })
})

describe('getScopedDevinSessionModels', () => {
  it('scopes model rows to orca-attributed location-model entries', () => {
    const mixed = session({
      modelBreakdown: [
        {
          modelKey: 'M1',
          modelLabel: 'M1',
          estimatedCostUsd: null,
          eventCount: 7,
          inputTokens: 700,
          cachedInputTokens: 70,
          outputTokens: 70,
          reasoningOutputTokens: 0,
          totalTokens: 770
        }
      ],
      locationModelBreakdown: [
        locationModel({ modelKey: 'M1', worktreeId: 'w1', eventCount: 2, totalTokens: 220 }),
        locationModel({ modelKey: 'M1', worktreeId: null, eventCount: 5, totalTokens: 550 })
      ]
    })

    const rows = getScopedDevinSessionModels(mixed, 'orca')
    expect(rows).toEqual([
      expect.objectContaining({ modelKey: 'M1', eventCount: 2, totalTokens: 220 })
    ])
  })
})

describe('buildDevinUsageSummary', () => {
  it('groups top projects by projectKey so same-label worktrees do not merge', () => {
    const rows = [
      daily({ projectKey: 'pk1', projectLabel: 'main', totalTokens: 60 }),
      daily({ projectKey: 'pk2', projectLabel: 'main', totalTokens: 50 }),
      daily({ projectKey: 'pk3', projectLabel: 'other', totalTokens: 90 })
    ]
    const summary = buildDevinUsageSummary('all', 'all', rows, [])
    // Label grouping would merge the two 'main' rows to 110 and win.
    expect(summary.topProject).toBe('other')
  })

  it('reports cacheShare as cachedInputTokens over inclusive inputTokens', () => {
    const summary = buildDevinUsageSummary(
      'all',
      'all',
      [daily({ inputTokens: 100, cachedInputTokens: 40 })],
      []
    )
    expect(summary.cacheShare).toBeCloseTo(0.4)
    const empty = buildDevinUsageSummary('all', 'all', [daily({})], [])
    expect(empty.cacheShare).toBe(0)
  })
})

describe('buildDevinUsageBreakdownRows', () => {
  it('builds project rows keyed by projectKey', () => {
    const rows = buildDevinUsageBreakdownRows(
      'project',
      [
        daily({ projectKey: 'pk1', projectLabel: 'main', totalTokens: 60 }),
        daily({ projectKey: 'pk2', projectLabel: 'main', totalTokens: 50 })
      ],
      [],
      'all'
    )
    expect(rows.map((row) => row.key).sort()).toEqual(['pk1', 'pk2'])
    expect(rows.every((row) => row.label === 'main')).toBe(true)
  })

  it('counts a session toward a project row only through orca-attributed locations', () => {
    const mixed = session({
      locationBreakdown: [
        location({ locationKey: 'pk1', worktreeId: 'w1' }),
        location({ locationKey: 'pk2', worktreeId: null })
      ]
    })
    const rows = buildDevinUsageBreakdownRows(
      'project',
      [daily({ projectKey: 'pk1', worktreeId: 'w1' }), daily({ projectKey: 'pk2' })],
      [mixed],
      'orca'
    )
    expect(rows.find((row) => row.key === 'pk1')?.sessions).toBe(1)
    expect(rows.find((row) => row.key === 'pk2')?.sessions).toBe(0)
  })

  it('counts a session toward a model row only through orca-attributed share', () => {
    const mixed = session({
      locationModelBreakdown: [
        locationModel({ modelKey: 'M1', worktreeId: 'w1' }),
        locationModel({ modelKey: 'M2', modelLabel: 'M2', worktreeId: null })
      ]
    })
    const rows = buildDevinUsageBreakdownRows(
      'model',
      [daily({ model: 'M1', worktreeId: 'w1' }), daily({ model: 'M2' })],
      [mixed],
      'orca'
    )
    expect(rows.find((row) => row.key === 'M1')?.sessions).toBe(1)
    expect(rows.find((row) => row.key === 'M2')?.sessions).toBe(0)
  })
})

describe('buildDevinUsageRecentSessions', () => {
  it('scopes session rows to orca-attributed locations', () => {
    const mixed = session({
      locationBreakdown: [
        location({
          locationKey: 'a',
          worktreeId: 'w1',
          projectLabel: 'proj-a',
          eventCount: 2,
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120
        }),
        location({
          locationKey: 'b',
          worktreeId: null,
          projectLabel: 'proj-b',
          eventCount: 5,
          inputTokens: 500,
          outputTokens: 50,
          totalTokens: 550
        })
      ]
    })

    const [row] = buildDevinUsageRecentSessions([mixed], 'orca')
    expect(row.totalTokens).toBe(120)
    expect(row.inputTokens).toBe(100)
    expect(row.events).toBe(2)
    expect(row.projectLabel).toBe('proj-a')

    const [allRow] = buildDevinUsageRecentSessions([mixed], 'all')
    expect(allRow.totalTokens).toBe(670)
    expect(allRow.projectLabel).toBe('Multiple locations')
  })
})
