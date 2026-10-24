import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { z } from 'zod'
import { expect, vi } from 'vitest'
import type SyncDatabase from '../../sqlite/sync-database'

/** Observe real expression evaluations, preserving its value, predicates and access plan. */
export function observeMailSqlWork(
  database: SyncDatabase,
  matches: (sql: string) => boolean,
  expression: string
) {
  const native = z
    .instanceof(DatabaseSync)
    .parse(Object.getOwnPropertyDescriptor(database, 'db')?.value)
  let evaluations = 0
  let observing = true
  const statements = new Map<string, string>()
  native.function('observe_mail_work', { deterministic: true }, (value) => {
    if (observing) {
      evaluations++
    }
    return value
  })
  const prepare = database.prepare.bind(database)
  const spy = vi.spyOn(database, 'prepare').mockImplementation((sql) => {
    if (!matches(sql)) {
      return prepare(sql)
    }
    expect(sql).toContain(expression)
    const instrumented = sql.replace(expression, `observe_mail_work(${expression})`)
    statements.set(sql, instrumented)
    return prepare(instrumented)
  })
  return {
    count: () => evaluations,
    reset: () => {
      evaluations = 0
    },
    verify: (parameters: (sql: string) => SQLInputValue[]) => {
      expect(statements.size).toBeGreaterThan(0)
      observing = false
      try {
        for (const [original, instrumented] of statements) {
          const args = parameters(original)
          expect(native.prepare(`EXPLAIN QUERY PLAN ${instrumented}`).all(...args)).toEqual(
            native.prepare(`EXPLAIN QUERY PLAN ${original}`).all(...args)
          )
          expect(native.prepare(instrumented).all(...args)).toEqual(
            native.prepare(original).all(...args)
          )
        }
      } finally {
        observing = true
      }
    },
    restore: () => spy.mockRestore()
  }
}
