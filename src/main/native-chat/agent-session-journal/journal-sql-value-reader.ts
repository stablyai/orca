import type { JournalSqlScope } from './journal-sql-scope'
import type { JournalSqlItemValues } from './journal-sql-item-values'
import type { JournalSqlValueObjects } from './journal-sql-value-objects'
import {
  decodeJournalSqlValue,
  journalSqlLocationKey,
  readJournalSqlReferencePath,
  type JournalSqlValueLocation,
  type StoredJournalSqlValue
} from './journal-sql-value-codec'

export class JournalSqlValueReader {
  readonly loaded = new Map<string, unknown>()

  constructor(
    private readonly scope: JournalSqlScope,
    private readonly objects: JournalSqlValueObjects,
    private readonly items?: JournalSqlItemValues
  ) {}

  load(location: JournalSqlValueLocation, json?: unknown): unknown {
    const key = journalSqlLocationKey(location)
    if (!this.loaded.has(key)) {
      let encoded = json
      if (encoded === undefined) {
        const row = this.scope.db
          .prepare(`SELECT value_json FROM journal_proj_values
          WHERE session_id=? AND generation=? AND collection=? AND entry_key=? AND incarnation=?
          UNION ALL SELECT value_json FROM journal_proj_value_snapshots
          WHERE session_id=? AND generation=? AND collection=? AND entry_key=? AND incarnation=? LIMIT 1`)
          .get(
            ...this.scope.prefix,
            location.collection,
            location.key,
            location.incarnation,
            ...this.scope.prefix,
            location.collection,
            location.key,
            location.incarnation
          )
        if (!row) {
          throw new Error('Missing journal projection object incarnation')
        }
        this.scope.examined(row)
        encoded = row.value_json
      }
      const payload =
        location.collection === 'items' && this.items
          ? this.items.load(location, encoded)
          : this.scope.decode<StoredJournalSqlValue>(encoded)
      const value = decodeJournalSqlValue(payload, (ref) => this.load(ref))
      const reference =
        typeof value === 'object' && value !== null && this.objects.locations.has(value)
      this.loaded.set(key, reference ? value : this.objects.track(value, { ...location, path: [] }))
    }
    return readJournalSqlReferencePath(this.loaded.get(key), location.path)
  }
}
