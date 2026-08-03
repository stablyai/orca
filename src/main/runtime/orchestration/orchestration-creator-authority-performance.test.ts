import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'

const CREATOR_PANE = 'tab-creator:11111111-1111-4111-8111-111111111111'
const CREATOR_PROCESS = 'pty-creator:incarnation-a'

function sqliteFor(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}

describe('creator authority lookup performance', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => db?.close())

  it('uses bounded creator-handle and pane-leaf indexes', () => {
    db = new OrchestrationDb(':memory:')
    const sqlite = sqliteFor(db)
    const taskPlan = sqlite
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT t.*, creator.id
         FROM tasks t
         LEFT JOIN dispatch_contexts creator ON creator.rowid = (
           SELECT candidate.rowid
           FROM dispatch_contexts candidate
           WHERE candidate.assignee_handle = t.created_by_terminal_handle
             AND candidate.run_id = ?
             AND candidate.status IN ('pending', 'dispatched')
           ORDER BY candidate.rowid DESC LIMIT 1
         )
         WHERE t.id = ?`
      )
      .all('run-owner', 'task-worker') as { detail: string }[]
    const panePlan = sqlite
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT * FROM dispatch_contexts
         WHERE assignee_pane_key IS NOT NULL
           AND status IN ('pending', 'dispatched')
           AND substr(assignee_pane_key, instr(assignee_pane_key, ':') + 1) = ?`
      )
      .all('11111111-1111-4111-8111-111111111111') as { detail: string }[]
    const taskDetails = taskPlan.map((row) => row.detail).join(' | ')
    const paneDetails = panePlan.map((row) => row.detail).join(' | ')

    expect(taskDetails).toContain('idx_dispatch_assignee_handle')
    expect(taskDetails).not.toMatch(/SCAN (?:runs|rebound)/)
    expect(paneDetails).toContain('idx_dispatch_assignee_pane_leaf')
  })

  it('keeps 300 Task reads bounded with 50,000 retained Runs', () => {
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'owner',
      coordinatorHandle: 'term-coordinator',
      coordinatorPaneKey: 'tab-coordinator:22222222-2222-4222-8222-222222222222'
    })
    const creatorTask = db.createTask({ spec: 'creator', runId: run.id })
    db.createDispatchContext(
      creatorTask.id,
      'term-creator',
      CREATOR_PANE,
      undefined,
      CREATOR_PROCESS
    )
    const workerTask = db.createTask({
      spec: 'worker',
      runId: run.id,
      createdByTerminalHandle: 'term-creator',
      createdByPaneKey: CREATOR_PANE,
      createdByProcessIncarnation: CREATOR_PROCESS,
      createdByRunGeneration: run.consumer_generation
    })
    sqliteFor(db)
      .prepare(
        `WITH RECURSIVE run_numbers(value) AS (
           VALUES (1) UNION ALL SELECT value + 1 FROM run_numbers WHERE value < ?
         )
         INSERT INTO runs (id, objective, coordinator_handle, consumer_generation, legacy)
         SELECT printf('retained_%05d', value), 'retained', printf('term_%05d', value), 1, 0
         FROM run_numbers`
      )
      .run(50_000)

    for (let index = 0; index < 10; index += 1) {
      db.getTask(workerTask.id, run.id)
    }
    const startedAt = performance.now()
    for (let index = 0; index < 300; index += 1) {
      expect(db.getTask(workerTask.id, run.id)?.creator_dispatch_run_id).toBe(run.id)
    }
    const elapsedMs = performance.now() - startedAt

    expect(elapsedMs).toBeLessThan(200)
  })
})
