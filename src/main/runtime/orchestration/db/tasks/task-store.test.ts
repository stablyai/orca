import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'

// Every Task belongs to a Run, so each case seeds the one coordinator Run its rows hang off.
function seedRun(db: OrchestrationDb): string {
  return db.createRun({
    objective: 'count tasks',
    coordinatorHandle: 'term_c',
    coordinatorPaneKey: 'tab_c:leaf_c'
  }).id
}

describe('countTasks', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => db?.close())

  // Why: `orca serve stats` advertises live counts, and settled task rows stay in the table until an
  // explicit reset — so terminal rows must not inflate the count, while `blocked` (resumable) must.
  it('counts only non-terminal task rows', () => {
    db = new OrchestrationDb(':memory:')
    const runId = seedRun(db)
    const statuses = ['pending', 'ready', 'dispatched', 'blocked', 'completed', 'failed'] as const
    for (const status of statuses) {
      const task = db.createTask({ spec: `task ${status}`, runId })
      db.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, task.id)
    }

    expect(db.countTasks()).toBe(4)
  })

  it('returns 0 once every task has settled', () => {
    db = new OrchestrationDb(':memory:')
    const runId = seedRun(db)
    const completed = db.createTask({ spec: 'settled ok', runId })
    const failed = db.createTask({ spec: 'settled bad', runId })
    db.updateTaskStatus(completed.id, 'completed')
    db.updateTaskStatus(failed.id, 'failed')

    expect(db.countTasks()).toBe(0)
  })

  // Why: `serve stats` publishes this histogram as a fixed-key object, so a status with no rows
  // has to read as 0 rather than disappear, and the terminal statuses `countTasks` drops have to
  // still be here — that pile is what operators were tabulating by hand (#13047).
  it('groups every task row by status, keeping statuses with no rows at zero', () => {
    db = new OrchestrationDb(':memory:')
    const runId = seedRun(db)
    for (const status of ['dispatched', 'dispatched', 'completed', 'blocked'] as const) {
      const task = db.createTask({ spec: `task ${status}`, runId })
      db.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, task.id)
    }
    db.createTask({ spec: 'still ready', runId })

    expect(db.countTasksByStatus()).toEqual({
      pending: 0,
      ready: 1,
      dispatched: 2,
      completed: 1,
      failed: 0,
      blocked: 1
    })
    // Deliberately larger than countTasks: that field excludes the settled row.
    expect(db.countTasks()).toBe(4)
  })
})
