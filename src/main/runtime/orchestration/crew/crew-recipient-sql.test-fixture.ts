import { vi } from 'vitest'
import type Database from '../../../sqlite/sync-database'
import type { SqliteBindings, SqliteRow } from '../../../sqlite/sqlite-statement'

export function selectedKeyMultiplier(sql: string): number {
  return sql.includes('AS recorded')
    ? 2
    : sql.includes("'handle' AS branch")
      ? 3
      : sql.includes('candidates AS (')
        ? 2
        : sql.includes('coordinator.run_id FROM json_each')
          ? 1
          : 0
}

export type CrewSqlExecution = {
  phase: string
  sql: string
  parameters: SqliteBindings
  method: 'all' | 'get' | 'run' | 'iterate'
  rows: number
  stringChars: number
  results: SqliteRow[]
  chars: number
  bytes: number
  keys: number
  requestChars: number
  failed: boolean
}

export function meterCrewSql(db: Database.Database) {
  const executions: CrewSqlExecution[] = []
  const control: { phase: string; before?: (sql: string) => void } = { phase: 'trigger' }
  const prepare = db.prepare.bind(db)
  const spy = vi.spyOn(db, 'prepare').mockImplementation((sql) => {
    const statement = prepare(sql)
    const begin = (method: CrewSqlExecution['method'], parameters: SqliteBindings) => {
      const multiplier = selectedKeyMultiplier(sql)
      const requested: unknown =
        multiplier && typeof parameters[0] === 'string' ? JSON.parse(parameters[0]) : null
      const entry: CrewSqlExecution = {
        phase: control.phase,
        sql,
        parameters,
        method,
        rows: 0,
        stringChars: 0,
        results: [],
        chars: 0,
        bytes: 0,
        keys: Array.isArray(requested) ? multiplier * requested.length : 0,
        requestChars: multiplier && typeof parameters[0] === 'string' ? parameters[0].length : 0,
        failed: false
      }
      executions.push(entry)
      return entry
    }
    const observe = (entry: CrewSqlExecution, rows: SqliteRow[]) => {
      entry.rows += rows.length
      for (const row of rows) {
        entry.results.push(row)
        for (const value of Object.values(row)) {
          if (typeof value === 'string') {
            entry.stringChars += value.length
          }
        }
      }
      const serialized = JSON.stringify(rows)
      entry.chars += serialized.length
      entry.bytes += Buffer.byteLength(serialized)
    }
    const execute = <T>(entry: CrewSqlExecution, call: () => T): T => {
      try {
        control.before?.(sql)
        return call()
      } catch (error) {
        entry.failed = true
        throw error
      }
    }
    return {
      all: (...parameters) => {
        const entry = begin('all', parameters)
        return execute(entry, () => {
          const rows = statement.all(...parameters)
          observe(entry, rows)
          return rows
        })
      },
      get: (...parameters) => {
        const entry = begin('get', parameters)
        return execute(entry, () => {
          const row = statement.get(...parameters)
          observe(entry, row === undefined ? [] : [row])
          return row
        })
      },
      run: (...parameters) => execute(begin('run', parameters), () => statement.run(...parameters)),
      iterate: (...parameters) => {
        const entry = begin('iterate', parameters)
        const iterator = execute(entry, () => statement.iterate(...parameters))
        return (function* () {
          try {
            for (const row of iterator) {
              observe(entry, [row])
              yield row
            }
          } catch (error) {
            entry.failed = true
            throw error
          }
        })()
      },
      setReadBigInts: (enabled) => statement.setReadBigInts(enabled)
    }
  })
  return { executions, control, restore: () => spy.mockRestore() }
}

export function sqlTotals(executions: CrewSqlExecution[]) {
  return executions.reduce(
    (sum, row) => ({
      all: sum.all + Number(row.method === 'all'),
      get: sum.get + Number(row.method === 'get'),
      run: sum.run + Number(row.method === 'run'),
      iterate: sum.iterate + Number(row.method === 'iterate'),
      rows: sum.rows + row.rows,
      stringChars: sum.stringChars + row.stringChars,
      chars: sum.chars + row.chars,
      bytes: sum.bytes + row.bytes,
      selected: sum.selected + Number(selectedKeyMultiplier(row.sql) > 0),
      keys: sum.keys + row.keys,
      requestChars: sum.requestChars + row.requestChars,
      failed: sum.failed + Number(row.failed)
    }),
    {
      all: 0,
      get: 0,
      run: 0,
      iterate: 0,
      rows: 0,
      stringChars: 0,
      chars: 0,
      bytes: 0,
      selected: 0,
      keys: 0,
      requestChars: 0,
      failed: 0
    }
  )
}

export function crewQueryPlans(db: Database.Database, executions: readonly CrewSqlExecution[]) {
  const actual = executions.filter(
    (row) =>
      !row.failed && row.phase !== 'diagnostic' && (row.method === 'all' || row.method === 'get')
  )
  return {
    version: db.prepare('SELECT sqlite_version() AS version').get(),
    schema: db
      .prepare(
        'SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name'
      )
      .all(),
    plans: actual.map(({ sql, parameters }) => ({
      sql,
      parameters,
      plan: db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters)
    }))
  }
}
