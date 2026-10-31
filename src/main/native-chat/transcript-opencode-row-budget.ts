import type SyncDatabase from '../sqlite/sync-database'

type BindValue = SyncDatabase.BindValue
type SqliteStatement = SyncDatabase.Statement

// Every transcript query reads within one row and byte budget so a corrupt store cannot exhaust memory.
export function rowsOf<T>(statement: SqliteStatement, ...params: BindValue[]): T[] {
  return rowsWithinBudget<T>(statement, { bytes: 0 }, ...params)
}

export function rowsWithinBudget<T>(
  statement: SqliteStatement,
  budget: { bytes: number },
  ...params: BindValue[]
): T[] {
  const rows: ReturnType<SqliteStatement['all']> = []
  for (const row of statement.iterate(...params)) {
    budget.bytes += Object.values(row).reduce<number>(
      (size, value) => size + (typeof value === 'string' ? Buffer.byteLength(value) : 0),
      0
    )
    if (rows.length >= 10000 || budget.bytes > 16 * 1024 * 1024) {
      throw new Error('OpenCode transcript query exceeds its read limit')
    }
    rows.push(row)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Each caller names the columns projected by its internal SQL query.
  return rows as T[]
}
