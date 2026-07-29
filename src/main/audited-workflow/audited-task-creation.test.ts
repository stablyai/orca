import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from '../sqlite/sync-database'
import { createAuditedWorkflowTables, migrateAuditedWorkflowSchema } from './audited-task-schema'
import { createAuditedTaskAtomically, type CreateAuditedTaskInput } from './audited-task-creation'

function baseInput(overrides: Partial<CreateAuditedTaskInput> = {}): CreateAuditedTaskInput {
  return {
    repoId: 'repo1',
    sourceRepoPath: '/repos/repo1',
    baseCommit: 'a'.repeat(40),
    hostId: 'local',
    title: 'Fix the thing',
    spec: { title: 'Fix the thing', description: 'Details' },
    source: 'custom',
    risk: 'low',
    ...overrides
  }
}

describe('createAuditedTaskAtomically', () => {
  let db: Database.Database | undefined

  afterEach(() => {
    db?.close()
    db = undefined
    vi.restoreAllMocks()
  })

  function freshDb(): Database.Database {
    db = new Database(':memory:')
    createAuditedWorkflowTables(db)
    migrateAuditedWorkflowSchema(db)
    return db
  }

  it('writes both the task row and its task_created transition in the success case', () => {
    const database = freshDb()
    const created = createAuditedTaskAtomically(database, baseInput(), 1000)

    const taskRow = database.prepare('SELECT * FROM audited_tasks WHERE id = ?').get(created.id)
    expect(taskRow).toBeDefined()

    const transitionRows = database
      .prepare('SELECT * FROM audited_transitions WHERE task_id = ?')
      .all(created.id)
    expect(transitionRows).toHaveLength(1)
  })

  it('rolls back the task insert when the transition insert fails (failure injection)', () => {
    const database = freshDb()
    const realPrepare = database.prepare.bind(database)
    const prepareSpy = vi.spyOn(database, 'prepare').mockImplementation((sql: string) => {
      if (sql.includes('INSERT INTO audited_transitions')) {
        throw new Error('injected failure: transition insert')
      }
      return realPrepare(sql)
    })

    expect(() => createAuditedTaskAtomically(database, baseInput(), 2000)).toThrow(
      'injected failure: transition insert'
    )

    prepareSpy.mockRestore()

    // No task row survives without its initial transition — the whole
    // attempt rolled back, not just the failing statement.
    const allTasks = database.prepare('SELECT * FROM audited_tasks').all()
    expect(allTasks).toHaveLength(0)
    const allTransitions = database.prepare('SELECT * FROM audited_transitions').all()
    expect(allTransitions).toHaveLength(0)
  })

  it('rolls back the transition insert when the task insert fails (failure injection, inverse order)', () => {
    const database = freshDb()
    const realPrepare = database.prepare.bind(database)
    const prepareSpy = vi.spyOn(database, 'prepare').mockImplementation((sql: string) => {
      if (sql.includes('INSERT INTO audited_tasks')) {
        throw new Error('injected failure: task insert')
      }
      return realPrepare(sql)
    })

    expect(() => createAuditedTaskAtomically(database, baseInput(), 3000)).toThrow(
      'injected failure: task insert'
    )

    prepareSpy.mockRestore()

    const allTasks = database.prepare('SELECT * FROM audited_tasks').all()
    expect(allTasks).toHaveLength(0)
    const allTransitions = database.prepare('SELECT * FROM audited_transitions').all()
    expect(allTransitions).toHaveLength(0)
  })

  it('a later successful creation still works after a rolled-back attempt (transaction state is clean)', () => {
    const database = freshDb()
    const realPrepare = database.prepare.bind(database)
    const prepareSpy = vi.spyOn(database, 'prepare').mockImplementationOnce((sql: string) => {
      if (sql.includes('INSERT INTO audited_tasks')) {
        throw new Error('injected failure')
      }
      return realPrepare(sql)
    })

    expect(() =>
      createAuditedTaskAtomically(database, baseInput({ title: 'First' }), 4000)
    ).toThrow()
    prepareSpy.mockRestore()

    const created = createAuditedTaskAtomically(database, baseInput({ title: 'Second' }), 5000)
    expect(created.title).toBe('Second')

    const allTasks = database.prepare('SELECT * FROM audited_tasks').all()
    expect(allTasks).toHaveLength(1)
  })
})
