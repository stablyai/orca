import type { SqliteRow } from '../../sqlite/sqlite-statement'
import type { JournalSqlScope } from './journal-sql-scope'
import type { JournalSqlItemValues } from './journal-sql-item-values'
import type {
  EncodedJournalSqlValue,
  JournalSqlValueLocation,
  JournalSqlValueReference,
  StoredJournalSqlValue
} from './journal-sql-value-codec'
import { journalSqlInputEntity } from './journal-sql-input-entities'
import { journalSqlPrimitiveFact } from './journal-sql-primitive-facts'
import { journalSqlMemberIds } from './journal-sql-membership-tables'
import { JournalSqlItemEntity } from './journal-sql-item-entity'

/** One reducer collection's typed table: current membership, order and saved incarnations. */
export type JournalSqlEntity = {
  size: () => number
  header: (key: string) => SqliteRow | undefined
  load: (location: JournalSqlValueLocation) => StoredJournalSqlValue | undefined
  /** The entity incarnations this saved row captures. */
  captured: (location: JournalSqlValueLocation) => JournalSqlValueReference[]
  counters: (added: boolean, replaced: boolean) => SqliteRow
  importCounters: (size: number) => void
  store: (
    location: JournalSqlValueLocation,
    encoded: EncodedJournalSqlValue,
    value: unknown,
    current: boolean,
    ordinal: number,
    preserve?: boolean
  ) => void
  update: (
    location: JournalSqlValueLocation,
    encoded: EncodedJournalSqlValue,
    value: unknown
  ) => boolean
  delete: (key: string) => void
  remove: (location: JournalSqlValueLocation) => boolean
  keys: (limit?: number) => string[]
}

export class JournalSqlDomainTables {
  constructor(
    private readonly scope: JournalSqlScope,
    private readonly items?: JournalSqlItemValues
  ) {}

  for(collection: string): JournalSqlEntity {
    const entity =
      (collection === 'items' && this.items
        ? new JournalSqlItemEntity(this.scope, this.items)
        : undefined) ??
      journalSqlInputEntity(this.scope, collection) ??
      journalSqlPrimitiveFact(this.scope, collection) ??
      journalSqlMemberIds(this.scope, collection)
    if (!entity) {
      throw new Error(`journal projection collection ${collection} has no typed table`)
    }
    return entity
  }
}
