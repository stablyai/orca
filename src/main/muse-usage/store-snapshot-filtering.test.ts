import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MuseUsageStore } from './store'
import { museUsageAggregation } from './scanner'
import * as filters from '../usage/usage-scope-filters'
import type { MuseUsageAttributedEvent } from './types'

const fake = vi.hoisted(() => ({ directory: '' }))
vi.mock('electron', () => ({ app: { getPath: () => fake.directory } }))
vi.mock('../usage-cache-snapshot-writer', () => ({
  UsageCacheSnapshotWriter: class {
    flush = async () => {}
    write = async () => {}
  }
}))

class FixtureStore extends MuseUsageStore {
  constructor(count: number) {
    super({ getRepos: () => [], getAllWorktreeMeta: () => ({}) })
    const events: MuseUsageAttributedEvent[] = Array.from({ length: count }, (_, index) => {
      const day = ['2026-09-25', '2026-08-01', '2026-05-01'][index % 3]
      const inside = index % 2 === 0
      return {
        sessionId: `session-${index}`,
        timestamp: `${day}T12:00:00.000Z`,
        day,
        eventKey: String(index),
        cwd: null,
        model: index % 4 === 0 ? null : `model-${index % 3}`,
        projectKey: `project-${index % 4}`,
        projectLabel: `Project ${index % 4}`,
        repoId: inside ? 'repo' : null,
        worktreeId: inside ? `folder-${index % 4}` : null,
        inputTokens: 100,
        cachedInputTokens: 20,
        outputTokens: 10,
        reasoningOutputTokens: 2,
        totalTokens: 110
      }
    })
    const projection = museUsageAggregation.aggregate(events)
    this.state = { ...this.state, ...projection }
  }
}

beforeEach(() => {
  fake.directory = mkdtempSync(join(tmpdir(), 'orca-muse-snapshot-'))
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 8, 26, 12))
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  rmSync(fake.directory, { recursive: true, force: true })
})

it('filters each accumulated projection once per snapshot', () => {
  const store = new FixtureStore(20_000)
  const daily = vi.spyOn(filters, 'filterUsageDaily')
  const sessions = vi.spyOn(filters, 'filterUsageSessions')
  const result = store.getSnapshot('orca', '30d')
  expect(result.summary.sessions).toBeGreaterThan(0)
  expect(result.recentSessions).toHaveLength(10)
  expect(sessions.mock.calls[0]?.[0]).toHaveLength(20_000)
  expect({ daily: daily.mock.calls.length, sessions: sessions.mock.calls.length }).toEqual({
    daily: 1,
    sessions: 1
  })
})

it.each(['orca', 'all'] as const)(
  'keeps snapshot projections equal to individual %s reads',
  async (scope) => {
    const store = new FixtureStore(30)
    for (const range of ['7d', '30d', '90d', 'all'] as const) {
      for (const limit of [0, 1, 10]) {
        const snapshot = store.getSnapshot(scope, range, limit)
        expect(snapshot).toEqual({
          scanState: store.getScanState(),
          summary: await store.getSummary(scope, range),
          daily: await store.getDaily(scope, range),
          modelBreakdown: await store.getBreakdown(scope, range, 'model'),
          projectBreakdown: await store.getBreakdown(scope, range, 'project'),
          recentSessions: await store.getRecentSessions(scope, range, limit)
        })
      }
    }
  }
)

it('keeps empty snapshots and later calls independent', () => {
  const store = new FixtureStore(0)
  const first = store.getSnapshot('all', 'all')
  const next = store.getSnapshot('orca', '7d', 0)
  expect(first.daily).toEqual([])
  expect(first.recentSessions).toEqual([])
  expect(next.summary).toMatchObject({
    sessions: 0,
    events: 0,
    totalTokens: 0,
    scope: 'orca',
    range: '7d'
  })
})
