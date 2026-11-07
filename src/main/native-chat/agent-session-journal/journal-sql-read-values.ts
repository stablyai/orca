import type { JournalSqlScope } from './journal-sql-scope'
import { JournalSqlItemValues } from './journal-sql-item-values'
import { JournalSqlValueReader } from './journal-sql-value-reader'
import { JournalSqlValueObjects } from './journal-sql-value-objects'
import { JournalSqlDomainTables } from './journal-sql-domain-tables'
import type { JournalSqlValueLocation } from './journal-sql-value-codec'

class ReadObjects extends JournalSqlValueObjects {
  constructor(private readonly decoded: (location: JournalSqlValueLocation) => void) {
    super(() => {})
  }

  override track(value: unknown, location: JournalSqlValueLocation): unknown {
    this.decoded(location)
    return value
  }
}

/** One reader transaction owns plain decoded values; no tracked proxy crosses a worker port. */
export class JournalSqlReadValues extends JournalSqlValueReader {
  private readonly current: JournalSqlDomainTables

  constructor(scope: JournalSqlScope, decoded: (location: JournalSqlValueLocation) => void) {
    const items = new JournalSqlItemValues(scope)
    super(scope, new ReadObjects(decoded), items)
    this.current = new JournalSqlDomainTables(scope, items)
  }

  get<T>(collection: string, id: string | number): T | undefined {
    const key = JSON.stringify(id)
    const header = this.current.for(collection).header(key)
    if (!header) {
      return undefined
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: callers name the typed domain collection owning T.
    return this.load({ collection, key, incarnation: Number(header.incarnation), path: [] }) as T
  }

  has(collection: string, id: string | number): boolean {
    return this.current.for(collection).header(JSON.stringify(id)) !== undefined
  }
}
