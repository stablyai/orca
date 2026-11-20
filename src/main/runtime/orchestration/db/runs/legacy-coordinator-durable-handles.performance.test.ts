import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import { LEGACY_COORDINATOR_DURABLE_HANDLES_SQL } from './legacy-coordinator-mail-takeover'

const RUN = 'run_adopted'
const ADOPTED_AT = '2026-06-01 00:00:00'
const dirs: string[] = []
const dbs: OrchestrationDb[] = []

afterEach(() => {
  for (const db of dbs.splice(0)) {
    db.close()
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

// A run with ~1,400 Dispatches over a few hundred Tasks, the shape that froze the main process.
function seedLargeRun(): OrchestrationDb {
  const dir = mkdtempSync(join(tmpdir(), 'orca-legacy-durable-'))
  dirs.push(dir)
  const db = new OrchestrationDb(join(dir, 'orchestration.db'))
  dbs.push(db)
  const task = db.db.prepare(
    `INSERT INTO tasks (id, run_id, spec, created_by_terminal_handle, created_at)
     VALUES (?, ?, 'spec', ?, ?)`
  )
  const dispatch = db.db.prepare(
    `INSERT INTO dispatch_contexts (id, run_id, task_id, status) VALUES (?, ?, ?, 'completed')`
  )
  db.db.exec('BEGIN')
  for (let i = 0; i < 340; i++) {
    task.run(`task_${i}`, RUN, i % 2 ? 'term_coord_a' : 'term_coord_b', '2026-05-01 00:00:00')
    for (let j = 0; j < 4; j++) {
      dispatch.run(`ctx_${i}_${j}`, RUN, `task_${i}`)
    }
  }
  task.run('task_undispatched', RUN, 'term_no_dispatch', '2026-05-01 00:00:00')
  task.run('task_late', RUN, 'term_late', '2026-07-01 00:00:00')
  dispatch.run('ctx_late', RUN, 'task_late')
  task.run('task_cross_run', RUN, 'term_cross_run', '2026-05-01 00:00:00')
  dispatch.run('ctx_cross_run', 'run_other', 'task_cross_run')
  db.db.exec('COMMIT')
  return db
}

describe('legacy coordinator durable handles', () => {
  it('probes dispatch_contexts by task, not by run', () => {
    const db = seedLargeRun()
    const plan = db.db
      .prepare(`EXPLAIN QUERY PLAN ${LEGACY_COORDINATOR_DURABLE_HANDLES_SQL}`)
      .all(ADOPTED_AT, RUN, ADOPTED_AT)
      .map((row) => String(row.detail))
    expect(plan.filter((detail) => / d\b/.test(detail))).toEqual([
      expect.stringContaining('USING INDEX idx_dispatch_task (task_id=?)')
    ])

    const handles = db.db
      .prepare(LEGACY_COORDINATOR_DURABLE_HANDLES_SQL)
      .all(ADOPTED_AT, RUN, ADOPTED_AT)
      .map((row) => String(row.handle))
    expect(handles.sort()).toEqual(['term_coord_a', 'term_coord_b'])
  })
})
