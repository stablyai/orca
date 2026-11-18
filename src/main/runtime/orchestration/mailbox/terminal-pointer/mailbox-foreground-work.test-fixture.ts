import { expect, vi } from 'vitest'
import type { OrchestrationDb } from '../../db/orchestration-db'
import { sqliteFor } from './orchestration-mailbox-notification-test-harness'

/** Count SQL range rows, including rejected rows, without changing the populated access plan. */
export function countForegroundSqlWork(db: OrchestrationDb) {
  const counts = { statements: 0, owners: 0, messages: 0 }
  const ownerRows: string[] = []
  const messageRows: string[] = []
  const sqlite = sqliteFor(db)
  sqlite.function('mail_owner_row', (id) => {
    ownerRows.push(String(id))
    counts.owners++
    return 1
  })
  sqlite.function('mail_message_row', (id) => {
    messageRows.push(String(id))
    counts.messages++
    return 1
  })
  const prepare = sqlite.prepare.bind(sqlite)
  const plans = new Set<string>()
  const checked = new Set<string>()
  const spy = vi.spyOn(sqlite, 'prepare').mockImplementation((sql) => {
    const instrumented = sql.replace(
      /FROM (runs|messages)(\s+(?:INDEXED BY \w+\s+)?WHERE)\b/g,
      (_, table: string, suffix: string) =>
        `FROM ${table}${suffix} mail_${table === 'runs' ? 'owner' : 'message'}_row(${table}.id) AND`
    )
    const statement = prepare(instrumented)
    const check = (bindings: Parameters<typeof statement.all>) => {
      counts.statements++
      if (instrumented === sql || checked.has(sql)) {
        return
      }
      checked.add(sql)
      const original = prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...bindings)
        .map((row) => row.detail)
      const actual = prepare(`EXPLAIN QUERY PLAN ${instrumented}`)
        .all(...bindings)
        .map((row) => row.detail)
      expect(actual).toEqual(original)
      for (const detail of actual) {
        plans.add(String(detail))
      }
    }
    return {
      ...statement,
      all(...bindings) {
        check(bindings)
        return statement.all(...bindings)
      },
      get(...bindings) {
        check(bindings)
        return statement.get(...bindings)
      },
      run(...bindings) {
        check(bindings)
        return statement.run(...bindings)
      },
      iterate(...bindings) {
        check(bindings)
        return statement.iterate(...bindings)
      }
    }
  })
  return {
    counts,
    ownerRows,
    messageRows,
    plans,
    stop: () => spy.mockRestore(),
    clear: () => {
      ownerRows.length = 0
      messageRows.length = 0
      counts.statements = 0
      counts.owners = 0
      counts.messages = 0
    }
  }
}
