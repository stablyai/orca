import { vi } from 'vitest'
import type { SqliteBindings } from '../../sqlite/sqlite-statement'
import type { OrchestrationDb } from '../../runtime/orchestration/db'

/** Count actual SQL calls/results and their plans; EXPLAIN itself is excluded. */
export function observeReceivingSql(db: OrchestrationDb) {
  const prepare = db.db.prepare.bind(db.db)
  const instrumented = new WeakSet<object>()
  const restores: (() => void)[] = []
  const plans: string[] = []
  const measurements = { prepares: 0, executions: 0, rows: 0, allRows: 0, plans }
  const explain = (sql: string, args: SqliteBindings) => {
    if (!/^\s*(SELECT|WITH)\b/i.test(sql)) {
      return
    }
    for (const row of prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args)) {
      if (typeof row.detail === 'string') {
        measurements.plans.push(row.detail)
      }
    }
  }
  const spy = vi.spyOn(db.db, 'prepare').mockImplementation((sql) => {
    measurements.prepares += 1
    const statement = prepare(sql)
    if (instrumented.has(statement)) {
      return statement
    }
    instrumented.add(statement)
    const all = statement.all.bind(statement)
    const get = statement.get.bind(statement)
    const run = statement.run.bind(statement)
    const allSpy = vi.spyOn(statement, 'all').mockImplementation((...args) => {
      measurements.executions += 1
      explain(sql, args)
      const rows = all(...args)
      measurements.rows += rows.length
      measurements.allRows += rows.length
      return rows
    })
    const getSpy = vi.spyOn(statement, 'get').mockImplementation((...args) => {
      measurements.executions += 1
      explain(sql, args)
      const row = get(...args)
      measurements.rows += row === undefined ? 0 : 1
      return row
    })
    const runSpy = vi.spyOn(statement, 'run').mockImplementation((...args) => {
      measurements.executions += 1
      return run(...args)
    })
    restores.push(
      () => allSpy.mockRestore(),
      () => getSpy.mockRestore(),
      () => runSpy.mockRestore()
    )
    return statement
  })
  return {
    measurements,
    stop: () => {
      spy.mockRestore()
      for (const restore of restores.toReversed()) {
        restore()
      }
    }
  }
}
