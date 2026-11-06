import type { SqliteRow } from '../../sqlite/sqlite-statement'
import type { JournalSqlScope } from './journal-sql-scope'
import type { JournalSqlItemValues } from './journal-sql-item-values'
import { encodeJournalSqlValue, type JournalSqlValueLocation } from './journal-sql-value-codec'
import { JournalSqlDomainTables } from './journal-sql-domain-tables'

type Entry = { value: unknown; ordinal: number; incarnation: number }

/** Empty-generation imports have no replaced incarnations or mutations to track. */
export class JournalSqlValueBulkLoad {
  private readonly collections = new Map<string, Map<string, Entry>>()
  private readonly locations = new WeakMap<object, JournalSqlValueLocation>()
  private readonly tables: JournalSqlDomainTables

  constructor(
    private readonly scope: JournalSqlScope,
    private readonly items: JournalSqlItemValues | undefined
  ) {
    this.tables = new JournalSqlDomainTables(scope)
    if (
      scope.db
        .prepare(`SELECT collection FROM journal_proj_collections
        WHERE session_id=? AND generation=? LIMIT 1`)
        .get(...scope.prefix)
    ) {
      throw new Error('Journal bulk load requires an empty generation')
    }
  }

  size(collection: string): number {
    return this.collections.get(collection)?.size ?? 0
  }

  header(collection: string, key: string): SqliteRow | undefined {
    const entry = this.collections.get(collection)?.get(key)
    return entry && { ordinal: entry.ordinal, incarnation: entry.incarnation }
  }

  read<T>(collection: string, key: string): T | undefined {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: typed keyed views own the values written under their collection names.
    return this.collections.get(collection)?.get(key)?.value as T | undefined
  }

  write(collection: string, key: string, value: unknown): void {
    let entries = this.collections.get(collection)
    if (!entries) {
      entries = new Map()
      this.collections.set(collection, entries)
    }
    if (entries.has(key)) {
      throw new Error('Journal bulk load cannot replace an entry')
    }
    const ordinal = entries.size + 1
    const location = { collection, key, incarnation: ordinal, path: [] }
    const encoded = encodeJournalSqlValue(
      value,
      location,
      (object) => this.locations.get(object),
      (object, path) => {
        if (!this.locations.has(object)) {
          this.locations.set(object, { ...location, path })
        }
      }
    )
    const entity = this.tables.for(collection)
    if (entity) {
      entity.store(location, encoded.json, value, true, ordinal)
    } else {
      this.scope.db
        .prepare(`INSERT INTO journal_proj_values
      (session_id, generation, collection, entry_key, ordinal, incarnation, value_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(
          ...this.scope.prefix,
          collection,
          key,
          ordinal,
          ordinal,
          collection === 'items' && this.items
            ? this.items.store(location, encoded.json, value, true, ordinal)
            : encoded.json
        )
    }
    for (const { source } of encoded.refs) {
      this.scope.db
        .prepare(`INSERT OR IGNORE INTO journal_proj_value_refs
        (session_id, generation, holder_collection, holder_key, holder_incarnation,
         source_collection, source_key, source_incarnation) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          ...this.scope.prefix,
          collection,
          key,
          ordinal,
          source.collection,
          source.key,
          source.incarnation
        )
    }
    entries.set(key, { value, ordinal, incarnation: ordinal })
  }

  finish(): void {
    const insert = this.scope.db.prepare(`INSERT INTO journal_proj_collections
      (session_id, generation, collection, size, next_ordinal, next_incarnation)
      VALUES (?, ?, ?, ?, ?, ?)`)
    for (const [collection, entries] of this.collections) {
      const entity = this.tables.for(collection)
      if (entity) {
        entity.importCounters(entries.size)
      } else {
        insert.run(...this.scope.prefix, collection, entries.size, entries.size, entries.size)
      }
    }
  }
}
