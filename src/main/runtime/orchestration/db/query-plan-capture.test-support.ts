import { expect, vi } from 'vitest'
import type { OrchestrationDb } from './orchestration-db'

/** The query plan of every statement `act` prepares that reads or writes one of `tables`. */
export function plansOf(db: OrchestrationDb, tables: string[], act: () => void): string[] {
  const prepare = vi.spyOn(db.db, 'prepare')
  act()
  const statements = prepare.mock.calls
    .map(([sql]) => sql)
    .filter((sql) => tables.some((table) => sql.includes(table)))
  prepare.mockRestore()
  expect(statements.length).toBeGreaterThan(0)
  return statements.flatMap((sql) =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: EXPLAIN QUERY PLAN rows carry a detail column.
    (db.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map(
      ({ detail }) => detail
    )
  )
}
