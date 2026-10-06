import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './db'
import { createRootDispatch } from './db/root-dispatch-test-fixture'

describe('task promotion query allocation', () => {
  const databases: OrchestrationDb[] = []

  afterEach(() => {
    vi.restoreAllMocks()
    for (const database of databases) {
      database.close()
    }
    databases.length = 0
  })

  function createDb(): OrchestrationDb {
    const database = new OrchestrationDb(':memory:')
    databases.push(database)
    return database
  }

  it.each(['task update', 'worker report'] as const)(
    'reads only promotion metadata when completing through a %s',
    (route) => {
      const db = createDb()
      const target = db.createTask({ runId: 'run_legacy_local', spec: 'Completing task' })
      const open = db.createTask({ runId: 'run_legacy_local', spec: 'Open dependency' })
      const spec = `Retained specification\n${'x'.repeat(256 * 1024)}`
      let retainedTaskId = ''
      for (let index = 0; index < 32; index++) {
        retainedTaskId = db.createTask({
          runId: 'run_legacy_local',
          spec,
          taskTitle: 'Retained task',
          deps: [open.id]
        }).id
      }
      const child = db.createTask({
        runId: 'run_legacy_local',
        spec: 'Dependent task',
        deps: [target.id, target.id]
      })
      const dispatch =
        route === 'worker report' ? createRootDispatch(db, target.id, 'term_worker') : null
      const observations: { rowCount: number; columns: string[]; textBytes: number }[] = []
      const prepare = db.db.prepare.bind(db.db)
      vi.spyOn(db.db, 'prepare').mockImplementation((sql) => {
        const statement = prepare(sql)
        if (sql.includes("FROM tasks WHERE status = 'pending'")) {
          const all = statement.all.bind(statement)
          vi.spyOn(statement, 'all').mockImplementation((...params) => {
            const rows = all(...params)
            const columns = new Set<string>()
            let textBytes = 0
            for (const row of rows) {
              for (const [column, value] of Object.entries(row)) {
                columns.add(column)
                if (typeof value === 'string') {
                  textBytes += Buffer.byteLength(value, 'utf8')
                }
              }
            }
            observations.push({ rowCount: rows.length, columns: [...columns].sort(), textBytes })
            return rows
          })
        }
        return statement
      })

      if (dispatch) {
        expect(
          db.settleWorkerReport({
            taskId: target.id,
            dispatchId: dispatch.id,
            outcome: 'succeeded',
            result: 'Done'
          })
        ).toEqual({ action: 'settled', outcome: 'succeeded', duplicate: false })
      } else {
        expect(db.updateTaskStatus(target.id, 'completed', 'Done')).toEqual({
          ...target,
          status: 'completed',
          result: 'Done',
          completed_at: expect.any(String)
        })
      }

      expect(observations).toHaveLength(1)
      expect(observations[0]?.rowCount).toBe(33)
      expect(observations[0]?.columns).toEqual(['deps', 'id'])
      expect(observations[0]?.textBytes).toBeLessThan(8 * 1024)
      expect(db.getTask(child.id)).toMatchObject({
        status: 'ready',
        spec: child.spec,
        deps: child.deps
      })
      expect(db.getTask(retainedTaskId)).toMatchObject({ status: 'pending', spec })
      expect(db.getTask(target.id)).toMatchObject({ status: 'completed', result: 'Done' })
    }
  )

  it.each(['ready', 'failed', 'blocked'] as const)(
    'leaves a dependent pending when another dependency is %s',
    (status) => {
      const db = createDb()
      const target = db.createTask({ runId: 'run_legacy_local', spec: 'Completing task' })
      const other = db.createTask({ runId: 'run_legacy_local', spec: 'Other dependency' })
      if (status !== 'ready') {
        db.updateTaskStatus(other.id, status)
      }
      const child = db.createTask({
        runId: 'run_legacy_local',
        spec: 'Dependent task',
        deps: [target.id, other.id]
      })

      db.updateTaskStatus(target.id, 'completed')

      expect(db.getTask(child.id)?.status).toBe('pending')
    }
  )

  it.each(['not-json', 'null', '{}', '2'])(
    'rolls back completion and earlier promotions on persisted malformed deps %s',
    (deps) => {
      const db = createDb()
      const target = db.createTask({ runId: 'run_legacy_local', spec: 'Completing task' })
      const child = db.createTask({
        runId: 'run_legacy_local',
        spec: 'Promoted before malformed row',
        deps: [target.id]
      })
      const run = db.createRun({
        objective: 'Other run',
        coordinatorHandle: 'term_other',
        coordinatorPaneKey: 'tab_other:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      })
      const open = db.createTask({ runId: run.id, spec: 'Other dependency' })
      const malformed = db.createTask({ runId: run.id, spec: 'Malformed task', deps: [open.id] })
      db.db.prepare('UPDATE tasks SET deps = ? WHERE id = ?').run(deps, malformed.id)

      expect(() => db.updateTaskStatus(target.id, 'completed', 'Must roll back')).toThrow()

      expect(db.getTask(target.id)).toEqual(target)
      expect(db.getTask(child.id)).toEqual(child)
      expect(db.getTask(malformed.id)).toMatchObject({ status: 'pending', deps })
      expect(db.db.isTransaction).toBe(false)
    }
  )

  it('leaves promotion inside the caller-owned transaction', () => {
    const db = createDb()
    const target = db.createTask({ runId: 'run_legacy_local', spec: 'Completing task' })
    const child = db.createTask({ runId: 'run_legacy_local', spec: 'Child', deps: [target.id] })
    db.db.exec('BEGIN IMMEDIATE')

    db.updateTaskStatus(target.id, 'completed', 'Inside outer transaction')

    expect(db.db.isTransaction).toBe(true)
    expect(db.getTask(child.id)?.status).toBe('ready')
    db.db.exec('ROLLBACK')
    expect(db.getTask(target.id)).toEqual(target)
    expect(db.getTask(child.id)).toEqual(child)
  })
})
