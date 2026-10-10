import type { SQLInputValue, SQLOutputValue, StatementResultingChanges } from 'node:sqlite'

export type SqliteBindings = SQLInputValue[]
export type SqliteRow = Record<string, SQLOutputValue>

export type SqliteStatement = {
  all(...parameters: SqliteBindings): SqliteRow[]
  get(...parameters: SqliteBindings): SqliteRow | undefined
  run(...parameters: SqliteBindings): StatementResultingChanges
  iterate(...parameters: SqliteBindings): IterableIterator<SqliteRow>
  setReadBigInts(enabled: boolean): void
}
