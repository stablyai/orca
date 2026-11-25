import { afterEach, expect, it } from 'vitest'
import SyncDatabase from '../sqlite/sync-database'
import { createEventLoopStallSummary, type EventLoopStallWindow } from './event-loop-delay-probe'
import {
  longestSyncCall,
  recordSyncCallsOnThisThread,
  resetSyncCalls,
  resetSyncCallsForTests
} from './main-sync-calls'

afterEach(() => resetSyncCallsForTests())

it('names the slowest SQLite statement main ran during a gap of a second or more', () => {
  recordSyncCallsOnThisThread(true)
  const db = new SyncDatabase(':memory:')
  const windows: EventLoopStallWindow[] = []
  // Whole ms keep tick arithmetic exact, so no float rounding decides whether the window reports.
  const startedAt = Math.floor(performance.now())
  const summary = createEventLoopStallSummary(
    startedAt,
    {
      tickMs: 500,
      windowMs: 2_000,
      reportableMaxGapMs: 100,
      syncCalls: { longest: longestSyncCall, reset: resetSyncCalls }
    },
    (window) => windows.push(window)
  )
  db.prepare(
    'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300000) SELECT count(*) AS c FROM n'
  ).get()
  // Many quick statements after the slow one must not displace it.
  for (let index = 0; index < 100; index++) {
    db.prepare('SELECT 1 AS one').get()
  }
  // The next tick lands 1.5 s late, as if those statements had held the loop.
  summary.tick(startedAt + 2_000)
  db.close()

  expect(windows).toHaveLength(1)
  expect(windows[0]!.maxGapMs).toBe(1_500)
  expect(windows[0]!.longGapSyncCall).toMatchObject({ source: ':memory:' })
  expect(windows[0]!.longGapSyncCall?.label).toMatch(/^WITH RECURSIVE/)
  expect(windows[0]!.longGapStartedAtMs).toBeGreaterThanOrEqual(startedAt)
})
