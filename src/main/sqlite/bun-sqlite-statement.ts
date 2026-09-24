import type { SQLInputValue, StatementResultingChanges } from 'node:sqlite'
import { SqliteIntegerReader } from './sqlite-integer-reader'
import type { SqliteBindings, SqliteRow, SqliteStatement } from './sqlite-statement'

type BunBindings = (SQLInputValue | SQLInputValue[])[]
const EMPTY_BINDINGS: BunBindings = [[]]

export type BunStatement = {
  all(...parameters: BunBindings): SqliteRow[]
  get(...parameters: BunBindings): SqliteRow | null
  run(...parameters: BunBindings): StatementResultingChanges
  iterate(...parameters: BunBindings): IterableIterator<SqliteRow>
  finalize(): void
  safeIntegers(enabled: boolean): void
  readonly paramsCount: number
}

export class BunSqliteStatement implements SqliteStatement {
  private readonly integers = new SqliteIntegerReader()
  private readonly parameterCount: number

  constructor(
    private readonly statement: BunStatement,
    private readonly prepareIterator: () => BunStatement
  ) {
    statement.safeIntegers(true)
    this.parameterCount = statement.paramsCount
  }

  all(...parameters: SqliteBindings): SqliteRow[] {
    const rows = this.statement.all(...this.bindings(parameters))
    for (const row of rows) {
      this.integers.row(row)
    }
    return rows
  }

  get(...parameters: SqliteBindings): SqliteRow | undefined {
    const row = this.statement.get(...this.bindings(parameters))
    return row === null ? undefined : this.integers.row(row)
  }

  run(...parameters: SqliteBindings): StatementResultingChanges {
    return this.integers.result(this.statement.run(...this.bindings(parameters)))
  }

  *iterate(...parameters: SqliteBindings): IterableIterator<SqliteRow> {
    // Bun leaves interrupted iterators positioned on their last row and exposes no reset.
    const statement = this.prepareIterator()
    try {
      statement.safeIntegers(true)
      for (const row of statement.iterate(...this.bindings(parameters))) {
        yield this.integers.row(row)
      }
    } finally {
      statement.finalize()
    }
  }

  setReadBigInts(enabled: boolean): void {
    this.integers.readBigInts = enabled
  }

  private bindings(parameters: SqliteBindings): BunBindings {
    // No arguments would reuse the driver's previous bindings.
    if (parameters.length === 0) {
      return EMPTY_BINDINGS
    }
    if (parameters.length >= this.parameterCount) {
      return parameters
    }
    return [...parameters, ...Array<null>(this.parameterCount - parameters.length).fill(null)]
  }
}
