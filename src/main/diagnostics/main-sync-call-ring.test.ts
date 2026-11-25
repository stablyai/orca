import { afterEach, expect, it } from 'vitest'
import SyncDatabase from '../sqlite/sync-database'
import { createEventLoopStallSummary, type EventLoopStallWindow } from './event-loop-delay-probe'
import {
  longestSyncCallSince,
  recordSyncCallsOnThisThread,
  resetSyncCallsForTests
} from './main-sync-call-ring'

afterEach(() => resetSyncCallsForTests())

it('names the SQLite statement main entered during a gap of a second or more', () => {
  recordSyncCallsOnThisThread(true)
  const db = new SyncDatabase(':memory:')
  const windows: EventLoopStallWindow[] = []
  // Whole ms keep tick arithmetic exact; recorded calls still start at or after it.
  const startedAt = Math.floor(performance.now())
  const summary = createEventLoopStallSummary(
    startedAt,
    { tickMs: 500, windowMs: 2_000, reportableMaxGapMs: 100, longestSyncCallSince },
    (window) => windows.push(window)
  )
  db.exec('CREATE TABLE notes(body TEXT)')
  db.prepare('SELECT count(*) AS n FROM notes').get()
  // The next tick lands 1.5 s late, as if that statement had held the loop.
  summary.tick(startedAt + 2_000)
  db.close()

  expect(windows).toHaveLength(1)
  expect(windows[0]!.maxGapMs).toBe(1_500)
  expect(windows[0]!.longGapSyncCall).toMatchObject({ source: ':memory:' })
  expect(windows[0]!.longGapSyncCall?.label).toMatch(/^(CREATE TABLE notes|SELECT count)/)
  expect(windows[0]!.longGapStartedAtMs).toBeGreaterThanOrEqual(startedAt)
})
