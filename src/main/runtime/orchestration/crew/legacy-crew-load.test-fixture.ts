import { LEGACY_CONTRACT_VERSION } from '../db/contract-constants'
import type { OrchestrationDb } from '../db/orchestration-db'
import { ORCHESTRATION_LEGACY_RUN_ID as LEGACY_RUN_ID } from '../../../../shared/orchestration/orchestration-rpc-contract'

export const LEGACY_COORDINATOR = 'term_legacy_coord'

/** Synthetic only: a legacy-adopted Run the size of the 1.4.266 stall (#45290 follow-up), beside a few current Runs. */
export function seedLegacyCrewLoad(
  db: OrchestrationDb,
  { dispatches = 1400, creatorTasks = 330, mail = 30_000, workers = 400, otherRuns = 4 } = {}
): { adoptedRunId: string } {
  const adoptedRunId = 'run_legacy_adopted'
  const adoptedAt = '2026-11-10 00:00:00'
  const at = (index: number) =>
    new Date(Date.UTC(2026, 10, 1) + index * 1000).toISOString().replace('T', ' ').slice(0, 19)
  const run = db.db.prepare(
    `INSERT INTO runs (id, objective, coordinator_handle, coordinator_pane_key, legacy) VALUES (?, ?, ?, ?, 0)`
  )
  const task = db.db.prepare(
    `INSERT INTO tasks (id, run_id, created_by_terminal_handle, spec, task_title, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  const dispatch = db.db.prepare(
    `INSERT INTO dispatch_contexts (id, run_id, task_id, contract_version, assignee_handle, status, created_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const message = db.db.prepare(
    `INSERT INTO messages (id, run_id, delivery_contract, from_handle, to_handle, subject, body, type, payload, read, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
  )
  const question = db.db.prepare(
    `INSERT INTO question_threads (message_id, run_id, dispatch_id, asker_handle, status, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?)`
  )
  db.db.exec('BEGIN')
  {
    run.run(adoptedRunId, 'Recovered orchestration work', null, null)
    db.db
      .prepare(
        `INSERT INTO legacy_adoptions (source_run_id, adopted_run_id, scheduler_state_lost, adopted_at)
         VALUES (?, ?, 1, ?)`
      )
      .run(LEGACY_RUN_ID, adoptedRunId, adoptedAt)
    db.db
      .prepare(
        `INSERT INTO coordinator_runs (id, spec, status, coordinator_handle, scheduler_lost_at)
         VALUES ('coord_run_legacy', 'legacy coordinator', 'failed', ?, ?)`
      )
      .run(LEGACY_COORDINATOR, adoptedAt)
    const live = Math.min(20, dispatches)
    for (let i = 0; i < dispatches; i++) {
      const worker = `term_lw${i % workers}`
      const done = i >= live
      task.run(
        `task_l${i}`,
        adoptedRunId,
        i < creatorTasks ? LEGACY_COORDINATOR : null,
        `legacy task ${i}`,
        `Legacy ${i}`,
        done ? 'completed' : 'dispatched',
        at(i)
      )
      dispatch.run(
        `ctx_l${i}`,
        adoptedRunId,
        `task_l${i}`,
        LEGACY_CONTRACT_VERSION,
        worker,
        done ? 'completed' : 'dispatched',
        at(i),
        done ? at(i + 60) : null
      )
    }
    for (let i = 0; i < mail; i++) {
      const id = i % dispatches
      const worker = i % 7 === 0 ? `dispatch:ctx_l${id}` : `term_lw${id % workers}`
      const toCoordinator = i % 2 === 0
      const type = i % 11 === 0 ? 'heartbeat' : toCoordinator ? 'status' : 'dispatch'
      message.run(
        `msg_l${i}`,
        adoptedRunId,
        'legacy_direct',
        toCoordinator ? worker : i % 13 === 1 ? `run:${adoptedRunId}` : LEGACY_COORDINATOR,
        toCoordinator ? LEGACY_COORDINATOR : worker,
        'legacy mail',
        `legacy body ${i}`,
        type,
        null,
        at(i + dispatches)
      )
    }
    for (let i = 0; i < 200; i++) {
      const id = `msg_stop_l${i}`
      message.run(
        id,
        adoptedRunId,
        'current_delivery',
        `term_lw${i % workers}`,
        LEGACY_COORDINATOR,
        'approval',
        'needs approval',
        'escalation',
        JSON.stringify({
          approval: { approvalId: `apr_${i}`, worker: { dispatchId: `ctx_l${i}` } }
        }),
        at(mail + dispatches + i)
      )
    }
    for (let i = 0; i < 50; i++) {
      const id = `msg_q_l${i}`
      message.run(
        id,
        adoptedRunId,
        'legacy_direct',
        `term_lw${i % workers}`,
        LEGACY_COORDINATOR,
        'question',
        'which way?',
        'question',
        null,
        at(mail + dispatches + 200 + i)
      )
      question.run(id, adoptedRunId, `ctx_l${i}`, `term_lw${i % workers}`, at(i))
    }
    for (let r = 0; r < otherRuns; r++) {
      const runId = `run_other${r}`
      const coordinator = `term_c${r}`
      run.run(runId, `Other ${r}`, coordinator, `tab_c${r}:pane`)
      for (let i = 0; i < 60; i++) {
        task.run(
          `task_o${r}_${i}`,
          runId,
          coordinator,
          `other ${i}`,
          `Other ${i}`,
          'completed',
          at(i)
        )
        dispatch.run(
          `ctx_o${r}_${i}`,
          runId,
          `task_o${r}_${i}`,
          1,
          `term_o${r}_${i}`,
          'completed',
          at(i),
          at(i + 60)
        )
      }
      for (let i = 0; i < 2000; i++) {
        const worker = `term_o${r}_${i % 60}`
        message.run(
          `msg_o${r}_${i}`,
          runId,
          'current_delivery',
          i % 2 ? worker : coordinator,
          i % 2 ? coordinator : worker,
          'mail',
          `body ${i}`,
          'status',
          null,
          at(i)
        )
      }
    }
  }
  db.db.exec('COMMIT')
  return { adoptedRunId }
}
