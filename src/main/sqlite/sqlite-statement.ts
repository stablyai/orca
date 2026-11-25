import type { SQLInputValue, SQLOutputValue, StatementResultingChanges } from 'node:sqlite'

export type SqliteBindings = SQLInputValue[]
export type SqliteRow = Record<string, SQLOutputValue>

export type SqliteStatement<Row extends SqliteRow = SqliteRow> = {
  all(...parameters: SqliteBindings): Row[]
  get(...parameters: SqliteBindings): Row | undefined
  run(...parameters: SqliteBindings): StatementResultingChanges
  iterate(...parameters: SqliteBindings): IterableIterator<Row>
  setReadBigInts(enabled: boolean): void
}
