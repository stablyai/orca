import type { JournalSqlConversion, JournalSqlConversionTable } from './journal-sql-conversion'

/** Keep the one-time restore on its reader; only one acknowledged batch crosses to the host. */
export function* journalSqlConversionPages(
  conversion: JournalSqlConversion
): Generator<JournalSqlConversionTable> {
  for (const { name, columns, rows } of conversion.tables) {
    let page: unknown[][] = []
    let bytes = 0
    for (const row of rows) {
      const size = Buffer.byteLength(JSON.stringify(row))
      if (page.length > 0 && (page.length === 512 || bytes + size > 1024 * 1024)) {
        yield { name, columns, rows: page }
        page = []
        bytes = 0
      }
      page.push(row)
      bytes += size
    }
    if (page.length > 0) {
      yield { name, columns, rows: page }
    }
  }
}
