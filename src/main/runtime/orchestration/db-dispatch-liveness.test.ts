import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'

// Overwrites the datetime('now')-seeded timestamps with explicit fixture values
// so stale-detection assertions stay deterministic (no wall clock).
function setDispatchTimes(
  d: OrchestrationDb,
  id: string,
  dispatchedAt: string,
  heartbeatAt: string | null = null
): void {
  const sqlite = (d as unknown as { db: Database.Database }).db
  sqlite
    .prepare('UPDATE dispatch_contexts SET dispatched_at = ?, last_heartbeat_at = ? WHERE id = ?')
    .run(dispatchedAt, heartbeatAt, id)
}

describe('OrchestrationDb dispatch liveness', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
  })

  function createDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  describe('listActiveDispatchesForRun', () => {
    it('returns only pending and dispatched rows for the given run, oldest first', () => {
      const d = createDb()
      const run = d.createRun({
        objective: 'fleet',
        coordinatorHandle: 'term_coord',
        coordinatorPaneKey: 'tab_coord:11111111-1111-4111-8111-111111111111'
      })
      const active = d.createTask({ runId: run.id, spec: 'a' })
      const done = d.createTask({ runId: run.id, spec: 'b' })
      const firstDispatch = d.createDispatchContext(active.id, 'term_a')
      const secondDispatch = d.createDispatchContext(done.id, 'term_b')
      d.completeDispatch(secondDispatch.id)

      const rows = d.listActiveDispatchesForRun(run.id, 10)

      expect(rows.map((row) => row.id)).toEqual([firstDispatch.id])
    })

    it('caps the result at the requested limit', () => {
      const d = createDb()
      const run = d.createRun({
        objective: 'fleet',
        coordinatorHandle: 'term_coord',
        coordinatorPaneKey: 'tab_coord:11111111-1111-4111-8111-111111111111'
      })
      for (let index = 0; index < 5; index++) {
        const task = d.createTask({ runId: run.id, spec: `task ${index}` })
        d.createDispatchContext(task.id, `term_${index}`)
      }

      expect(d.listActiveDispatchesForRun(run.id, 3)).toHaveLength(3)
    })

    it('excludes another run and rejects a row whose two run ids disagree', () => {
      const d = createDb()
      const mine = d.createRun({
        objective: 'mine',
        coordinatorHandle: 'term_mine',
        coordinatorPaneKey: 'tab_mine:11111111-1111-4111-8111-111111111111'
      })
      const theirs = d.createRun({
        objective: 'theirs',
        coordinatorHandle: 'term_theirs',
        coordinatorPaneKey: 'tab_theirs:22222222-2222-4222-8222-222222222222'
      })
      const mineTask = d.createTask({ runId: mine.id, spec: 'mine' })
      const mineDispatch = d.createDispatchContext(mineTask.id, 'term_a')
      const theirsTask = d.createTask({ runId: theirs.id, spec: 'theirs' })
      d.createDispatchContext(theirsTask.id, 'term_b')

      expect(d.listActiveDispatchesForRun(mine.id, 10).map((row) => row.id)).toEqual([
        mineDispatch.id
      ])

      // Why: run_id is denormalized onto dispatch_contexts; if the two ever diverge the row must drop out rather than leak.
      ;(d as unknown as { db: Database.Database }).db
        .prepare('UPDATE dispatch_contexts SET run_id = ? WHERE id = ?')
        .run(theirs.id, mineDispatch.id)

      expect(d.listActiveDispatchesForRun(mine.id, 10)).toEqual([])
      expect(d.listActiveDispatchesForRun(theirs.id, 10).map((row) => row.id)).not.toContain(
        mineDispatch.id
      )
    })
  })

  describe('recordHeartbeat + getStaleDispatches', () => {
    it('recordHeartbeat updates last_heartbeat_at on dispatched rows', () => {
      const d = createDb()
      const task = d.createTask({ spec: 'work' })
      const ctx = d.createDispatchContext(task.id, 'term_a')

      d.recordHeartbeat(ctx.id, '2026-05-04T00:00:00.000Z')
      const after = d.getDispatchContext(task.id)
      expect(after?.last_heartbeat_at).toBe('2026-05-04T00:00:00.000Z')
    })

    it('recordHeartbeat is a no-op for completed rows (straggler ignored)', () => {
      const d = createDb()
      const task = d.createTask({ spec: 'work' })
      const ctx = d.createDispatchContext(task.id, 'term_a')
      d.completeDispatch(ctx.id)

      d.recordHeartbeat(ctx.id, '2026-05-04T00:00:00.000Z')
      const after = d.getDispatchContext(task.id)
      expect(after?.last_heartbeat_at).toBeNull()
    })

    it('getStaleDispatches returns only dispatched rows past the grace window', () => {
      const d = createDb()
      // Fixture: four rows, SQL-backdated timestamps (no fake clock):
      //  (a) dispatched, heartbeated 5 min ago → not stale
      //  (b) dispatched, heartbeated 12 min ago → STALE (expected result)
      //  (c) dispatched, never heartbeated, dispatched 30s ago → not stale (grace)
      //  (d) completed, heartbeated 30 min ago → not stale (status filter)
      const taskA = d.createTask({ spec: 'a' })
      const taskB = d.createTask({ spec: 'b' })
      const taskC = d.createTask({ spec: 'c' })
      const taskD = d.createTask({ spec: 'd' })
      const ctxA = d.createDispatchContext(taskA.id, 'term_a')
      const ctxB = d.createDispatchContext(taskB.id, 'term_b')
      const ctxC = d.createDispatchContext(taskC.id, 'term_c')
      const ctxD = d.createDispatchContext(taskD.id, 'term_d')
      d.completeDispatch(ctxD.id)

      const now = Date.now()
      const iso = (ms: number) => new Date(now - ms).toISOString()

      // Backdate dispatched_at for a, b, d to long ago so the grace doesn't
      // shield them. c keeps its default (≈now).
      const sqlite = (d as unknown as { db: Database.Database }).db
      sqlite
        .prepare(
          'UPDATE dispatch_contexts SET dispatched_at = ?, last_heartbeat_at = ? WHERE id = ?'
        )
        .run(iso(60 * 60 * 1000), iso(5 * 60 * 1000), ctxA.id)
      sqlite
        .prepare(
          'UPDATE dispatch_contexts SET dispatched_at = ?, last_heartbeat_at = ? WHERE id = ?'
        )
        .run(iso(60 * 60 * 1000), iso(12 * 60 * 1000), ctxB.id)
      sqlite
        .prepare('UPDATE dispatch_contexts SET dispatched_at = ? WHERE id = ?')
        .run(iso(30_000), ctxC.id)
      sqlite
        .prepare(
          'UPDATE dispatch_contexts SET dispatched_at = ?, last_heartbeat_at = ? WHERE id = ?'
        )
        .run(iso(60 * 60 * 1000), iso(30 * 60 * 1000), ctxD.id)

      const stale = d.getStaleDispatches(iso(10 * 60 * 1000))
      expect(stale.map((s) => s.id)).toEqual([ctxB.id])
    })

    // Regression for #8452: dispatched_at / last_heartbeat_at are written by
    // datetime('now') (space-format, e.g. "2026-07-12 12:00:00") while the
    // threshold is ISO ("...T11:55:00.000Z"). Raw TEXT ordering ranks the space
    // (0x20) below the 'T' (0x54) at index 10, flagging fresh same-date rows.
    it('getStaleDispatches ignores fresh SQLite space-format timestamps (#8452)', () => {
      const d = createDb()

      // Fresh worker: dispatched 12:00, heartbeat 12:05 (space-format), both
      // after the 11:55 threshold → NOT stale.
      const fresh = d.createDispatchContext(d.createTask({ spec: 'fresh' }).id, 'term_fresh')
      setDispatchTimes(d, fresh.id, '2026-07-12 12:00:00', '2026-07-12 12:05:00')

      // Legacy ISO-format fresh row (mixed-format table) stays fresh too.
      const legacy = d.createDispatchContext(d.createTask({ spec: 'legacy' }).id, 'term_legacy')
      setDispatchTimes(d, legacy.id, '2026-07-12T12:00:00.000Z', '2026-07-12T12:05:00.000Z')

      // Genuinely hung: dispatched + heartbeated at 10:00, ~2h before threshold.
      const hung = d.createDispatchContext(d.createTask({ spec: 'hung' }).id, 'term_hung')
      setDispatchTimes(d, hung.id, '2026-07-12 10:00:00', '2026-07-12 10:00:00')

      const stale = d.getStaleDispatches('2026-07-12T11:55:00.000Z')
      expect(stale.map((s) => s.id)).toEqual([hung.id])
    })

    it('getStaleDispatches keeps a just-dispatched space-format row in the grace window (#8452)', () => {
      const d = createDb()

      // Space-format dispatched_at one minute after the threshold, no heartbeat
      // yet → still inside the grace window, must not be flagged.
      const ctx = d.createDispatchContext(d.createTask({ spec: 'x' }).id, 'term_x')
      setDispatchTimes(d, ctx.id, '2026-07-12 12:00:00')

      const stale = d.getStaleDispatches('2026-07-12T11:59:00.000Z')
      expect(stale).toEqual([])
    })

    // Same-UTC-date midnight threshold: keeps the buggy space-vs-'T' compare in
    // play so this guards the fix at a day boundary (#8452; idea from @KMGeon's #8453).
    it('getStaleDispatches keeps a fresh row just after a UTC-midnight threshold (#8452)', () => {
      const d = createDb()

      const ctx = d.createDispatchContext(d.createTask({ spec: 'midnight' }).id, 'term_midnight')
      setDispatchTimes(d, ctx.id, '2026-05-04 00:04:00')

      const stale = d.getStaleDispatches('2026-05-04T00:00:00.000Z')
      expect(stale).toEqual([])
    })

    // Guards the last_heartbeat_at half of the fix on its own: a worker
    // dispatched long before the threshold (stale under either format) that
    // just sent a fresh space-format heartbeat must stay fresh (#8452).
    it('getStaleDispatches keeps a live worker with a fresh space-format heartbeat (#8452)', () => {
      const d = createDb()

      const ctx = d.createDispatchContext(d.createTask({ spec: 'live' }).id, 'term_live')
      setDispatchTimes(d, ctx.id, '2026-07-12 10:00:00', '2026-07-12 11:59:00')

      const stale = d.getStaleDispatches('2026-07-12T11:55:00.000Z')
      expect(stale).toEqual([])
    })
  })
})
