import type { JournalSqlScope } from './journal-sql-scope'
import type { JournalSqlItemValues } from './journal-sql-item-values'
import type { JournalSqlValueObjects } from './journal-sql-value-objects'
import { JournalSqlInputEntities } from './journal-sql-input-entities'
import {
  decodeJournalSqlValue,
  journalSqlLocationKey,
  readJournalSqlReferencePath,
  type JournalSqlValueLocation,
  type StoredJournalSqlValue
} from './journal-sql-value-codec'

export class JournalSqlValueReader {
  readonly loaded = new Map<string, unknown>()
  private readonly entities: JournalSqlInputEntities

  constructor(
    private readonly scope: JournalSqlScope,
    private readonly objects: JournalSqlValueObjects,
    private readonly items?: JournalSqlItemValues
  ) {
    this.entities = new JournalSqlInputEntities(scope)
  }

  size(collection: string): number {
    const entity = this.entities.for(collection)
    if (entity) {
      return entity.size()
    }
    const row = this.scope.db
      .prepare(`SELECT size FROM journal_proj_collections
        WHERE session_id=? AND generation=? AND collection=?`)
      .get(...this.scope.prefix, collection)
    return row ? Number(this.scope.examined(row).size) : 0
  }

  header(collection: string, key: string) {
    const entity = this.entities.for(collection)
    if (entity) {
      return entity.header(key)
    }
    const row = this.scope.db
      .prepare(`SELECT ordinal, incarnation FROM journal_proj_values
        WHERE session_id=? AND generation=? AND collection=? AND entry_key=?`)
      .get(...this.scope.prefix, collection, key)
    return row && this.scope.examined(row)
  }

  load(location: JournalSqlValueLocation, json?: unknown): unknown {
    const key = journalSqlLocationKey(location)
    if (!this.loaded.has(key)) {
      let encoded = json
      if (encoded === undefined) {
        const entity = this.entities.for(location.collection)
        const row = entity
          ? entity.load(location)
          : this.scope.db
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
        if (!entity) {
          this.scope.examined(row)
        }
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
