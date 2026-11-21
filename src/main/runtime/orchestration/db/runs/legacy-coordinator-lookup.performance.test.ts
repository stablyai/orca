import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import {
  LEGACY_COORDINATOR_DURABLE_HANDLES_SQL,
  LEGACY_COORDINATOR_MAIL_HANDLES_SQL
} from './legacy-coordinator-mail-takeover'

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

// Guards #45330 (Dispatch probe by task) and #45426 (legacy mail probes by address, coordinator_runs index):
// a run with ~1,400 Dispatches over a few hundred Tasks, the shape that froze the main process.
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
    `INSERT INTO dispatch_contexts (id, run_id, task_id, status, assignee_handle, contract_version)
     VALUES (?, ?, ?, 'completed', ?, 0)`
  )
  const mail = db.db.prepare(
    `INSERT INTO messages (id, run_id, delivery_contract, from_handle, to_handle, subject, created_at)
     VALUES (?, ?, 'legacy_direct', ?, ?, 's', '2026-05-01 00:00:00')`
  )
  let mailId = 0
  const send = (from: string, to: string, run = RUN) => mail.run(`msg_${mailId++}`, run, from, to)
  db.db.exec('BEGIN')
  for (let i = 0; i < 340; i++) {
    task.run(`task_${i}`, RUN, i % 2 ? 'term_coord_a' : 'term_coord_b', '2026-05-01 00:00:00')
    for (let j = 0; j < 4; j++) {
      dispatch.run(`ctx_${i}_${j}`, RUN, `task_${i}`, `term_worker_${i}_${j}`)
      send(`term_worker_${i}_${j}`, 'term_coord_a')
      send(`dispatch:ctx_${i}_${j}`, 'term_coord_a')
      send('term_coord_a', `term_worker_${i}_${j}`)
    }
  }
  task.run('task_undispatched', RUN, 'term_no_dispatch', '2026-05-01 00:00:00')
  task.run('task_late', RUN, 'term_late', '2026-07-01 00:00:00')
  dispatch.run('ctx_late', RUN, 'task_late', 'term_worker_late')
  task.run('task_cross_run', RUN, 'term_cross_run', '2026-05-01 00:00:00')
  dispatch.run('ctx_cross_run', 'run_other', 'task_cross_run', 'term_worker_other')
  send('term_worker_other', 'term_cross_run_mail')
  send('dispatch:ctx_cross_run', 'term_cross_run_mail')
  send('DISPATCH:ctx_0_0', 'term_wrong_case')
  send('dispatch:ctx_0_0\u0000x', 'term_nul_suffix')
  send('term_worker_0_0', 'term_other_run_mail', 'run_other')
  // A handle reused by many Dispatches in other Runs; with these statistics an assignee-only index loses to a scan.
  for (let i = 0; i < 2000; i++) {
    dispatch.run(`ctx_reused_${i}`, `run_reused_${i}`, 'task_cross_run', 'term_worker_0_0')
  }
  db.db
    .prepare(
      `INSERT INTO coordinator_runs (id, spec, coordinator_handle, scheduler_lost_at)
       VALUES ('crun_lost', 'spec', 'term_coord_a', ?)`
    )
    .run(ADOPTED_AT)
  const coordinatorRun = db.db.prepare(
    `INSERT INTO coordinator_runs (id, spec, coordinator_handle) VALUES (?, 'spec', 'term_coord_c')`
  )
  for (let i = 0; i < 500; i++) {
    coordinatorRun.run(`crun_${i}`)
  }
  db.db.exec('COMMIT')
  db.db.exec('ANALYZE')
  return db
}

describe('legacy coordinator lookup', () => {
  it('probes dispatch_contexts by task, not by run', () => {
    const db = seedLargeRun()
    const plan = db.db
      .prepare(`EXPLAIN QUERY PLAN ${LEGACY_COORDINATOR_DURABLE_HANDLES_SQL}`)
      .all(ADOPTED_AT, RUN, ADOPTED_AT)
      .map((row) => String(row.detail))
    expect(plan.filter((detail) => / d\b/.test(detail))).toEqual([
      expect.stringContaining('USING INDEX idx_dispatch_task (task_id=?)')
    ])
    expect(plan).toContainEqual(
      expect.stringContaining(
        'coordinator_runs USING INDEX idx_coordinator_runs_scheduler_lost (scheduler_lost_at=?)'
      )
    )

    const handles = db.db
      .prepare(LEGACY_COORDINATOR_DURABLE_HANDLES_SQL)
      .all(ADOPTED_AT, RUN, ADOPTED_AT)
      .map((row) => String(row.handle))
    expect(handles.sort()).toEqual(['term_coord_a', 'term_coord_b'])
  })

  it('probes dispatch_contexts by address for each legacy mail, not by run', () => {
    const db = seedLargeRun()
    const params = [RUN, ADOPTED_AT]
    const plan = db.db
      .prepare(`EXPLAIN QUERY PLAN ${LEGACY_COORDINATOR_MAIL_HANDLES_SQL}`)
      .all(...params)
      .map((row) => String(row.detail))
    const dispatchProbes = plan.filter((detail) => / d\b/.test(detail))
    expect(dispatchProbes).toHaveLength(4)
    for (const probe of dispatchProbes) {
      expect(probe).toMatch(
        /SEARCH d USING (COVERING )?INDEX (idx_dispatch_assignee_run_contract \(assignee_handle=\? AND run_id=\? AND contract_version=\?\)|sqlite_autoindex_dispatch_contexts_1 \(id=\?\))/
      )
    }
    expect(plan.filter((detail) => detail.includes('messages'))).toEqual([
      'SEARCH messages USING INDEX idx_messages_delivery_contract (run_id=? AND delivery_contract=?)'
    ])

    const handles = db.db
      .prepare(LEGACY_COORDINATOR_MAIL_HANDLES_SQL)
      .all(...params)
      .map((row) => String(row.handle))
    expect(handles.sort()).toEqual(['term_coord_a'])
  })
})
