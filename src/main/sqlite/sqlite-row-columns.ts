import type { SqliteRow } from './sqlite-statement'

// Typed reads of a row's columns: a value of another type reads as null.

export function textColumn(row: SqliteRow, column: string): string | null {
  const value = row[column]
  return typeof value === 'string' ? value : null
}

export function numberColumn(row: SqliteRow, column: string): number | null {
  const value = row[column]
  return typeof value === 'number' ? value : null
}

/** One text column of every row; a row without it is skipped. */
export function textColumnValues(rows: readonly SqliteRow[], column: string): string[] {
  return rows.flatMap((row) => {
    const value = textColumn(row, column)
    return value === null ? [] : [value]
  })
}
