import type { JournalSqlScope } from './journal-sql-scope'
import type { JournalSqlItemValues } from './journal-sql-item-values'
import type { JournalSqlValueObjects } from './journal-sql-value-objects'
import { JournalSqlDomainTables } from './journal-sql-domain-tables'
import {
  decodeJournalSqlValue,
  journalSqlLocationKey,
  readJournalSqlReferencePath,
  type JournalSqlValueLocation,
  type StoredJournalSqlValue
} from './journal-sql-value-codec'

/** Each saved incarnation decodes once per command, so every holder sees the same object. */
export class JournalSqlValueReader {
  readonly loaded = new Map<string, unknown>()
  private readonly tables: JournalSqlDomainTables

  constructor(
    scope: JournalSqlScope,
    private readonly objects: JournalSqlValueObjects,
    items?: JournalSqlItemValues
  ) {
    this.tables = new JournalSqlDomainTables(scope, items)
  }

  load(location: JournalSqlValueLocation, stored?: StoredJournalSqlValue): unknown {
    const key = journalSqlLocationKey(location)
    if (!this.loaded.has(key)) {
      const payload = stored ?? this.tables.for(location.collection).load(location)
      if (!payload) {
        throw new Error('Missing journal projection object incarnation')
      }
      const value = decodeJournalSqlValue(payload, (ref) => this.load(ref))
      const reference =
        typeof value === 'object' && value !== null && this.objects.locations.has(value)
      this.loaded.set(key, reference ? value : this.objects.track(value, { ...location, path: [] }))
    }
    return readJournalSqlReferencePath(this.loaded.get(key), location.path)
  }
}
