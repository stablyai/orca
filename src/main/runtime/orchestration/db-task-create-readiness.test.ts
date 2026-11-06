import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './db'

describe('task creation dependency readiness', () => {
  const databases: OrchestrationDb[] = []
  const directories: string[] = []

  afterEach(() => {
    vi.restoreAllMocks()
    for (const database of databases) {
      database.close()
    }
    for (const directory of directories) {
      rmSync(directory, { recursive: true, force: true })
    }
    databases.length = 0
    directories.length = 0
  })

  function createDb(path: string = ':memory:'): OrchestrationDb {
    const database = new OrchestrationDb(path)
    databases.push(database)
    return database
  }

  it('promotes only after every dependency completes', () => {
    const db = createDb()
    const first = db.createTask({ runId: 'run_legacy_local', spec: 'first' })
    const second = db.createTask({ runId: 'run_legacy_local', spec: 'second' })
    db.updateTaskStatus(first.id, 'completed')
    const child = db.createTask({
      runId: 'run_legacy_local',
      spec: 'child',
      deps: [first.id, second.id]
    })

    expect(child.status).toBe('pending')
    db.updateTaskStatus(second.id, 'completed')
    expect(db.getTask(child.id)?.status).toBe('ready')
  })

  it.each(['failed', 'blocked'] as const)(
    'does not unlock a dependent whose dependency is %s',
    (status) => {
      const db = createDb()
      const terminal = db.createTask({ runId: 'run_legacy_local', spec: 'terminal dependency' })
      const completing = db.createTask({ runId: 'run_legacy_local', spec: 'completing dependency' })
      db.updateTaskStatus(terminal.id, status)

      const child = db.createTask({
        runId: 'run_legacy_local',
        spec: 'child',
        deps: [terminal.id, completing.id]
      })

      expect(child.status).toBe('pending')
      db.updateTaskStatus(completing.id, 'completed')
      expect(db.getTask(child.id)?.status).toBe('pending')
    }
  )

  it('rejects missing dependencies without inserting a task', () => {
    const db = createDb()

    expect(() =>
      db.createTask({ runId: 'run_legacy_local', spec: 'child', deps: ['task_missing'] })
    ).toThrow('Dependency task task_missing must belong to run')
    expect(db.listTasks()).toEqual([])
  })

  it('preserves readiness and later promotion across reload', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-task-readiness-'))
    directories.push(directory)
    const path = join(directory, 'orchestration.db')
    const before = createDb(path)
    const completed = before.createTask({ runId: 'run_legacy_local', spec: 'completed' })
    const open = before.createTask({ runId: 'run_legacy_local', spec: 'open' })
    before.updateTaskStatus(completed.id, 'completed')
    const ready = before.createTask({
      runId: 'run_legacy_local',
      spec: 'ready',
      deps: [completed.id]
    })
    const pending = before.createTask({
      runId: 'run_legacy_local',
      spec: 'pending',
      deps: [completed.id, open.id]
    })
    before.close()
    databases.splice(databases.indexOf(before), 1)

    const after = createDb(path)

    expect(after.getTask(ready.id)?.status).toBe('ready')
    expect(after.getTask(pending.id)?.status).toBe('pending')
    after.updateTaskStatus(open.id, 'completed')
    expect(after.getTask(pending.id)?.status).toBe('ready')
  })
})
