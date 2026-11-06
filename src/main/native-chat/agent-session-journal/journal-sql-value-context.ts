import { JournalSqlValueReader } from './journal-sql-value-reader'
import { journalSqlIndexScope } from './journal-sql-index-values'
import { clearJournalSqlCollection } from './journal-sql-keyed-values'
import type { SqliteRow } from '../../sqlite/sqlite-statement'
import type { JournalSqlScope } from './journal-sql-scope'
import type { JournalEntryChange } from './journal-transition-collections'
import {
  encodeJournalSqlValue,
  journalSqlLocationKey,
  type JournalSqlValueLocation
} from './journal-sql-value-codec'
import { JournalSqlValueObjects } from './journal-sql-value-objects'
import { JournalSqlValueReferences } from './journal-sql-value-references'
import type { JournalSqlItemValues } from './journal-sql-item-values'
import { JournalSqlValueBulkLoad } from './journal-sql-value-bulk-load'
import { JournalSqlValueChanges } from './journal-sql-value-changes'
import { JournalSqlDomainTables } from './journal-sql-domain-tables'

/** One command owns these objects; SAVEPOINT rollback discards the context, never adopts a mirror. */
export class JournalSqlValueContext {
  changed?: (collection: string, key: string) => void
  private readonly objects = new JournalSqlValueObjects((location) => this.touch(location))
  private readonly reader: JournalSqlValueReader
  private readonly entries = new JournalSqlValueChanges()
  private readonly collections = new Set<string>()

  private readonly references: JournalSqlValueReferences
  private bulk?: JournalSqlValueBulkLoad
  readonly tables: JournalSqlDomainTables
  constructor(
    readonly scope: JournalSqlScope,
    readonly items?: JournalSqlItemValues
  ) {
    this.tables = new JournalSqlDomainTables(scope)
    this.reader = new JournalSqlValueReader(scope, this.objects, items)
    this.references = new JournalSqlValueReferences(
      scope,
      (location) => {
        const node = this.objects.tracked.get(journalSqlLocationKey(location))
        return (
          node &&
          encodeJournalSqlValue(node.raw, node.location, (object) =>
            this.objects.locations.get(object)
          )
        )
      },
      (location, encoded) => {
        const node = this.objects.tracked.get(journalSqlLocationKey(location))
        return location.collection === 'items' && this.items
          ? this.items.store(
              location,
              encoded,
              node?.raw,
              false,
              0,
              !!node && !this.objects.dirty.has(node)
            )
          : encoded
      },
      (location) => {
        if (location.collection === 'items') {
          this.items?.forget(location)
        }
      }
    )
  }

  indexScope(): JournalSqlScope {
    return journalSqlIndexScope(this)
  }

  bulkLoad(write: () => void): void {
    this.bulk = new JournalSqlValueBulkLoad(this.scope, this.items)
    try {
      write()
      this.bulk.finish()
    } finally {
      this.bulk = undefined
    }
  }

  readReference(location: JournalSqlValueLocation): unknown {
    const value = this.reader.load(location)
    this.objects.observe(value, location)
    return value
  }

  collection(name: string): void {
    if (this.tables.for(name) || this.collections.has(name)) {
      return
    }
    this.scope.db
      .prepare(`INSERT OR IGNORE INTO journal_proj_collections
      (session_id, generation, collection) VALUES (?, ?, ?)`)
      .run(...this.scope.prefix, name)
    this.collections.add(name)
  }

  access(collection: string): void {
    this.entries.accessed.add(collection)
  }

  size(collection: string): number {
    this.access(collection)
    if (this.bulk) {
      return this.bulk.size(collection)
    }
    return this.reader.size(collection)
  }

  header(collection: string, key: string): SqliteRow | undefined {
    this.access(collection)
    return this.bulk ? this.bulk.header(collection, key) : this.reader.header(collection, key)
  }

  read<V>(collection: string, key: string, observe = true): V | undefined {
    if (this.bulk) {
      return this.bulk.read<V>(collection, key)
    }
    const row = this.header(collection, key)
    if (!row) {
      return undefined
    }
    const location = { collection, key, incarnation: Number(row.incarnation), path: [] }
    const value = this.reader.load(location)
    if (observe) {
      this.objects.observe(value, location)
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each typed keyed view owns the values written under its collection name.
    return value as V
  }

  write(collection: string, key: string, value: unknown): void {
    if (this.bulk) {
      this.bulk.write(collection, key, value)
      this.changed?.(collection, key)
      return
    }
    this.collection(collection)
    const before = this.header(collection, key)
    const previous = before && {
      collection,
      key,
      incarnation: Number(before.incarnation),
      path: []
    }
    const source =
      typeof value === 'object' && value !== null ? this.objects.locations.get(value) : undefined
    const same = previous && source && this.reader.load(previous) === this.reader.load(source)
    const entity = this.tables.for(collection)
    const counters = entity
      ? entity.counters(!before, !same)
      : this.scope.db
          .prepare(`UPDATE journal_proj_collections SET
      size=size+?, next_ordinal=next_ordinal+?, next_incarnation=next_incarnation+?
      WHERE session_id=? AND generation=? AND collection=? RETURNING next_ordinal, next_incarnation`)
          .get(Number(!before), Number(!before), Number(!same), ...this.scope.prefix, collection)
    if (!counters) {
      throw new Error('Missing journal projection collection')
    }
    const location = {
      collection,
      key,
      incarnation: same ? previous.incarnation : Number(counters.next_incarnation),
      path: []
    }
    const encoded = encodeJournalSqlValue(value, location, (object) =>
      this.objects.locations.get(object)
    )
    if (previous && !same) {
      this.flushLocation(previous)
      if (
        encoded.refs.some(
          (ref) => journalSqlLocationKey(ref.source) === journalSqlLocationKey(previous)
        ) ||
        this.references.referenced(previous)
      ) {
        this.references.retain(previous)
      } else {
        this.references.drop(previous)
      }
    }
    if (entity) {
      entity.store(
        location,
        encoded.json,
        value,
        true,
        Number(before?.ordinal ?? counters.next_ordinal)
      )
    } else {
      this.scope.db
        .prepare(`INSERT INTO journal_proj_values
      (session_id, generation, collection, entry_key, ordinal, incarnation, value_json)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, generation, collection, entry_key)
      DO UPDATE SET incarnation=excluded.incarnation, value_json=excluded.value_json`)
        .run(
          ...this.scope.prefix,
          collection,
          key,
          Number(before?.ordinal ?? counters.next_ordinal),
          location.incarnation,
          location.collection === 'items' && this.items
            ? this.items.store(
                location,
                encoded.json,
                value,
                true,
                Number(before?.ordinal ?? counters.next_ordinal)
              )
            : encoded.json
        )
    }
    this.references.replace(location, encoded.refs)
    const stored = source ? this.reader.load(source) : this.objects.track(value, location)
    this.reader.loaded.set(journalSqlLocationKey(location), stored)
    this.objects.observe(stored, location)
    if (typeof stored === 'object' && stored !== null) {
      const owned = this.objects.locations.get(stored)
      const node = owned && this.objects.tracked.get(journalSqlLocationKey(owned))
      if (node) {
        this.objects.dirty.add(node)
      }
    }
    this.touch(location, !before)
  }

  delete(collection: string, key: string): boolean {
    const row = this.header(collection, key)
    if (!row) {
      return false
    }
    const location = { collection, key, incarnation: Number(row.incarnation), path: [] }
    this.flushLocation(location)
    if (this.references.referenced(location)) {
      this.references.retain(location)
    } else {
      this.references.drop(location)
    }
    const entity = this.tables.for(collection)
    if (entity) {
      entity.delete(key)
    } else {
      this.scope.db
        .prepare(`DELETE FROM journal_proj_values
      WHERE session_id=? AND generation=? AND collection=? AND entry_key=?`)
        .run(...this.scope.prefix, collection, key)
      this.scope.db
        .prepare(`UPDATE journal_proj_collections SET size=size-1
      WHERE session_id=? AND generation=? AND collection=?`)
        .run(...this.scope.prefix, collection)
    }
    if (collection === 'items') {
      this.items?.delete(key)
    }
    this.touch(location, false, true)
    return true
  }

  clear(collection: string): void {
    clearJournalSqlCollection(this, collection)
  }

  flush(): void {
    for (const node of this.objects.dirty) {
      this.flushLocation(node.location)
    }
  }

  untracked = (_key: string, value: unknown): unknown => this.objects.untracked(value)

  input<T>(value: T): T {
    return this.objects.input(value)
  }

  changes(reset = false): JournalEntryChange[] {
    return this.entries.read(this, reset)
  }

  private touch(location: JournalSqlValueLocation, reinsert = false, deleted = false): void {
    this.changed?.(location.collection, location.key)
    this.entries.touch(location, reinsert, deleted)
  }

  private flushLocation(location: JournalSqlValueLocation): void {
    const node = this.objects.tracked.get(journalSqlLocationKey(location))
    if (!node || !this.objects.dirty.delete(node)) {
      return
    }
    const encoded = encodeJournalSqlValue(node.raw, node.location, (object) =>
      this.objects.locations.get(object)
    )
    const header =
      location.collection === 'items' && this.items
        ? this.header(location.collection, location.key)
        : undefined
    const json =
      location.collection === 'items' && this.items
        ? this.items.store(
            location,
            encoded.json,
            node.raw,
            Number(header?.incarnation) === location.incarnation,
            Number(header?.ordinal ?? 0)
          )
        : encoded.json
    const updated = this.references.update(location, json, node.raw)
    if (!updated.stored) {
      if (location.collection === 'items') {
        this.items?.forget(location)
      }
      return
    }
    if (updated.current) {
      // A write through an alias changes its source's query columns even without a source read.
      this.changed?.(location.collection, location.key)
    }
    this.references.replace(location, encoded.refs)
  }
}
