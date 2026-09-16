import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import { SCHEMA_VERSION } from '../contract-constants'

describe('task provenance migration', () => {
  let db: OrchestrationDb | undefined
  afterEach(() => db?.close())

  it('upgrades v41 tasks without losing rows or derived delivery schema', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ runId: 'run_legacy_local', spec: 'existing task' })
    db.db.exec(`
      DROP INDEX IF EXISTS idx_tasks_worktree;
      ALTER TABLE tasks DROP COLUMN worktree_id;
      ALTER TABLE tasks DROP COLUMN branch;
    `)
    db.db.pragma('user_version = 41')

    db.migrate()

    expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    expect(db.getTask(task.id)).toMatchObject({
      spec: 'existing task',
      worktree_id: null,
      branch: null
    })
    expect(
      db.db.prepare('SELECT name FROM sqlite_master WHERE name = ?').get('idx_tasks_worktree')
    ).toBeDefined()
    expect(() => db!.db.prepare('SELECT * FROM outstanding_deliveries').all()).not.toThrow()
    expect(
      db.db
        .prepare('SELECT name FROM sqlite_master WHERE name = ?')
        .get('trg_deliveries_one_outstanding')
    ).toBeDefined()

    db.updateTaskProvenance(task.id, { worktreeId: 'repo::worktree', branch: 'feature' })
    db.migrate()
    expect(db.getTask(task.id)).toMatchObject({ worktree_id: 'repo::worktree', branch: 'feature' })
  })
})
