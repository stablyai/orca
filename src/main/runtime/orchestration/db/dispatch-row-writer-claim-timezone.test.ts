import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from '../../../sqlite/sync-database'
import { OrchestrationDb } from './orchestration-db'
import { exposeDispatchContext } from '../../rpc/methods/orchestration/worker/worker-observation'

// Why cast: the raw sqlite handle is a private implementation detail; tests reach past it
// only to seed deterministic fixture timestamps, same pattern as db.test.ts's setDispatchTimes.
function sqliteHandle(d: OrchestrationDb): Database.Database {
  return (d as unknown as { db: Database.Database }).db
}

// N1: the claim path (claimDispatchContextRow / DISPATCH_CONTEXT_CLAIM_SQL) stamped
// dispatched_at with SQLite's timezone-less `datetime('now')` ("YYYY-MM-DD HH:MM:SS", UTC
// wall-clock text with no zone marker), while completion writes a real ISO-with-'Z' string
// and the worker-show reader subtracted Date.parse of both. Node's Date.parse reads a
// zone-less "date-time" string as LOCAL time, so under a non-UTC TZ the claim timestamp is
// parsed as if it were that many hours away from UTC -- a 1s gap reads as that offset plus
// 1s. Skipped on Windows: Node there reads the OS timezone and ignores a runtime TZ env
// change, so the stub cannot work (see automation-cron-input-validation.test.ts).
describe.skipIf(process.platform === 'win32')('dispatch claim timestamp timezone (N1)', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    vi.unstubAllEnvs()
  })

  function readyTaskDispatch(d: OrchestrationDb) {
    const task = d.createTask({ runId: 'run_legacy_local', spec: 'timezone accounting task' })
    return d.createDispatchContext({
      taskId: task.id,
      assigneeHandle: 'term_worker',
      assigneePaneKey: 'tab_worker:leaf_worker',
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER
    })
  }

  it('writes the claim-path dispatched_at as ISO, not SQLite space-format text', () => {
    vi.stubEnv('TZ', 'Australia/Adelaide')
    db = new OrchestrationDb(':memory:')

    const dispatch = readyTaskDispatch(db)

    // Why not a regex on the raw column: the fixed contract is "parses correctly everywhere",
    // and the sharpest proof of that is that Date.parse round-trips it to a sane, current epoch
    // regardless of the process timezone -- a space-format value would not.
    expect(dispatch.dispatched_at).not.toBeNull()
    const parsed = Date.parse(dispatch.dispatched_at as string)
    expect(Number.isNaN(parsed)).toBe(false)
    expect(Math.abs(Date.now() - parsed)).toBeLessThan(5000)
  })

  it('computes wallclockMs from the true UTC gap, not skewed by a non-UTC process timezone', () => {
    vi.stubEnv('TZ', 'Australia/Adelaide')
    db = new OrchestrationDb(':memory:')
    const dispatch = readyTaskDispatch(db)

    // A legacy row (or a pre-fix write) can still hold SQLite's zone-less space format --
    // the reader must tolerate that too, so exercise it directly rather than only the
    // now-ISO write path.
    sqliteHandle(db)
      .prepare('UPDATE dispatch_contexts SET dispatched_at = ?, completed_at = ? WHERE id = ?')
      .run('2024-06-15 00:00:00', '2024-06-15T00:00:01.000Z', dispatch.id)

    const reloaded = db.getDispatchContextById(dispatch.id)
    const exposed = exposeDispatchContext(reloaded!)

    expect(exposed.wallclockMs).toBe(1000)
  })
})
