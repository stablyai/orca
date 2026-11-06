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

/** One command owns these objects; SAVEPOINT rollback discards the context, never adopts a mirror. */
export class JournalSqlValueContext {
  changed?: (collection: string, key: string) => void
  private readonly objects = new JournalSqlValueObjects((location) => this.touch(location))
  private readonly reader: JournalSqlValueReader
  private readonly pending = new Map<
    string,
    { location: JournalSqlValueLocation; reinsert: boolean }
  >()
  private readonly accessed = new Set<string>()
  private readonly collections = new Set<string>()

  private readonly references: JournalSqlValueReferences
  constructor(
    readonly scope: JournalSqlScope,
    readonly items?: JournalSqlItemValues
  ) {
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

  readReference(location: JournalSqlValueLocation): unknown {
    const value = this.reader.load(location)
    this.objects.observe(value, location)
    return value
  }

  collection(name: string): void {
    if (this.collections.has(name)) {
      return
    }
    this.scope.db
      .prepare(`INSERT OR IGNORE INTO journal_proj_collections
      (session_id, generation, collection) VALUES (?, ?, ?)`)
      .run(...this.scope.prefix, name)
    this.collections.add(name)
  }

  access(collection: string): void {
    this.accessed.add(collection)
  }

  size(collection: string): number {
    this.access(collection)
    const row = this.scope.db
      .prepare(`SELECT size FROM journal_proj_collections
      WHERE session_id=? AND generation=? AND collection=?`)
      .get(...this.scope.prefix, collection)
    if (row) {
      this.scope.examined(row)
    }
    return Number(row?.size ?? 0)
  }

  header(collection: string, key: string): SqliteRow | undefined {
    this.access(collection)
    const row = this.scope.db
      .prepare(`SELECT ordinal, incarnation FROM journal_proj_values
      WHERE session_id=? AND generation=? AND collection=? AND entry_key=?`)
      .get(...this.scope.prefix, collection, key)
    return row && this.scope.examined(row)
  }

  read<V>(collection: string, key: string, observe = true): V | undefined {
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
    const counters = this.scope.db
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
    this.scope.db
      .prepare(`DELETE FROM journal_proj_values
      WHERE session_id=? AND generation=? AND collection=? AND entry_key=?`)
      .run(...this.scope.prefix, collection, key)
    this.scope.db
      .prepare(`UPDATE journal_proj_collections SET size=size-1
      WHERE session_id=? AND generation=? AND collection=?`)
      .run(...this.scope.prefix, collection)
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
    const entries = [...this.pending.values()]
    const changes = [...this.accessed]
      .flatMap((collection) => entries.filter((entry) => entry.location.collection === collection))
      .map(({ location, reinsert }) => {
        const present = !!this.header(location.collection, location.key)
        return {
          path: location.collection,
          key: JSON.parse(location.key),
          deleted: !present,
          reinsert,
          value: this.read(location.collection, location.key)
        }
      })
    if (reset) {
      this.pending.clear()
    }
    return changes
  }

  private touch(location: JournalSqlValueLocation, reinsert = false, deleted = false): void {
    this.changed?.(location.collection, location.key)
    const key = JSON.stringify([location.collection, location.key])
    if (reinsert) {
      this.pending.delete(key)
    }
    const before = this.pending.get(key)
    this.pending.set(key, { location, reinsert: deleted ? false : reinsert || !!before?.reinsert })
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
    const updated = this.scope.db
      .prepare(`UPDATE journal_proj_values SET value_json=?
      WHERE session_id=? AND generation=? AND collection=? AND entry_key=? AND incarnation=?`)
      .run(json, ...this.scope.prefix, location.collection, location.key, location.incarnation)
    if (!updated.changes) {
      const snapshot = this.scope.db
        .prepare(`UPDATE journal_proj_value_snapshots SET value_json=?
        WHERE session_id=? AND generation=? AND collection=? AND entry_key=? AND incarnation=?`)
        .run(json, ...this.scope.prefix, location.collection, location.key, location.incarnation)
      if (!snapshot.changes) {
        if (location.collection === 'items') {
          this.items?.forget(location)
        }
        return
      }
    } else {
      // A write through an alias changes its source's query columns even without a source read.
      this.changed?.(location.collection, location.key)
    }
    this.references.replace(location, encoded.refs)
  }
}
