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

  private readonly references: JournalSqlValueReferences
  private bulk?: JournalSqlValueBulkLoad
  readonly tables: JournalSqlDomainTables
  constructor(
    readonly scope: JournalSqlScope,
    readonly items?: JournalSqlItemValues
  ) {
    this.tables = new JournalSqlDomainTables(scope, items)
    this.reader = new JournalSqlValueReader(scope, this.objects, items)
    this.references = new JournalSqlValueReferences(scope, this.tables, (location) => {
      const node = this.objects.tracked.get(journalSqlLocationKey(location))
      return (
        node && {
          encoded: this.encode(node.raw, node.location),
          raw: node.raw,
          unchanged: !this.objects.dirty.has(node)
        }
      )
    })
  }

  indexScope(): JournalSqlScope {
    return journalSqlIndexScope(this)
  }

  bulkLoad(write: () => void): void {
    this.bulk = new JournalSqlValueBulkLoad(this.tables)
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

  access(collection: string): void {
    this.entries.accessed.add(collection)
  }

  size(collection: string): number {
    this.access(collection)
    return this.bulk ? this.bulk.size(collection) : this.tables.for(collection).size()
  }

  header(collection: string, key: string): SqliteRow | undefined {
    this.access(collection)
    return this.bulk ? this.bulk.header(collection, key) : this.tables.for(collection).header(key)
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
    const entity = this.tables.for(collection)
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
    const counters = entity.counters(!before, !same)
    const location = {
      collection,
      key,
      incarnation: same ? previous.incarnation : Number(counters.next_incarnation),
      path: []
    }
    const encoded = this.encode(value, location)
    let released: JournalSqlValueLocation[] = []
    if (previous && !same) {
      this.flushLocation(previous)
      const self = encoded.refs.some(
        (ref) => journalSqlLocationKey(ref.source) === journalSqlLocationKey(previous)
      )
      if (!self && !this.references.referenced(previous)) {
        this.references.drop(previous)
      }
    } else if (previous) {
      released = this.references.captured(location)
    }
    entity.store(location, encoded, value, true, Number(before?.ordinal ?? counters.next_ordinal))
    this.references.replace(released, encoded.refs)
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
    const entity = this.tables.for(collection)
    entity.delete(key)
    if (!this.references.referenced(location)) {
      this.references.drop(location)
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

  private encode(value: unknown, location: JournalSqlValueLocation) {
    return encodeJournalSqlValue(value, location, (object) => this.objects.locations.get(object))
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
    const encoded = this.encode(node.raw, node.location)
    const previous = this.references.captured(location)
    const updated = this.references.update(location, encoded, node.raw)
    if (!updated.stored) {
      return
    }
    if (updated.current) {
      // A write through an alias changes its source's query columns even without a source read.
      this.changed?.(location.collection, location.key)
    }
    this.references.replace(previous, encoded.refs)
  }
}
