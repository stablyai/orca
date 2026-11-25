import { afterEach, expect, it } from 'vitest'
import SyncDatabase from '../sqlite/sync-database'
import { createEventLoopStallSummary, type EventLoopStallWindow } from './event-loop-delay-probe'
import {
  longestSyncCall,
  recordSyncCall,
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
  // Started a tick ago, so the first tick is due now and the statements below run inside its gap.
  const startedAt = Math.floor(performance.now()) - 500
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
  // The gap starts when the late tick was due, not when the named call began.
  expect(windows[0]!.longGapStartedAtMs).toBe(startedAt + 500)
})

it('names only a call that ran into the gap, not a longer one that finished before it', () => {
  const windows: EventLoopStallWindow[] = []
  const summary = createEventLoopStallSummary(
    0,
    {
      tickMs: 500,
      windowMs: 2_000,
      reportableMaxGapMs: 100,
      syncCalls: { longest: longestSyncCall, reset: resetSyncCalls }
    },
    (window) => windows.push(window)
  )
  // The summary started at 0, so its first tick is due at 500 and the gap starts there.
  recordSyncCall('a.db', 'SELECT a', 100, 400)
  recordSyncCall('b.db', 'SELECT b', 600, 700)
  recordSyncCall('c.db', 'SELECT c', 450, 560)
  summary.tick(2_000)

  // A ran longest but ended before 500; C ran 60 ms into the gap, B 100 ms.
  expect(windows[0]!.longGapStartedAtMs).toBe(500)
  expect(windows[0]!.longGapSyncCall).toEqual({
    source: 'b.db',
    label: 'SELECT b',
    startedAtMs: 600,
    durationMs: 100
  })
})
