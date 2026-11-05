import type { SqliteRow } from '../../sqlite/sqlite-statement'
import type { JournalSqlScope } from './journal-sql-scope'
import type { JournalEntryChange } from './journal-transition-collections'
import {
  decodeJournalSqlValue,
  encodeJournalSqlValue,
  journalSqlLocationKey,
  readJournalSqlReferencePath,
  type JournalSqlValueLocation
} from './journal-sql-value-codec'
import { JournalSqlValueObjects } from './journal-sql-value-objects'
import { JournalSqlValueReferences } from './journal-sql-value-references'

/** One command owns these objects; SAVEPOINT rollback discards the context, never adopts a mirror. */
export class JournalSqlValueContext {
  private readonly objects = new JournalSqlValueObjects((location) => this.touch(location))
  private readonly loaded = new Map<string, unknown>()
  private readonly pending = new Map<
    string,
    { location: JournalSqlValueLocation; reinsert: boolean }
  >()

  private readonly references: JournalSqlValueReferences
  constructor(readonly scope: JournalSqlScope) {
    this.references = new JournalSqlValueReferences(scope, (location) => {
      const node = this.objects.tracked.get(journalSqlLocationKey(location))
      return (
        node &&
        encodeJournalSqlValue(node.raw, node.location, (object) =>
          this.objects.locations.get(object)
        )
      )
    })
  }

  indexScope(): JournalSqlScope {
    return this.scope.withIndexValues({
      encode: (value, name, key) => {
        const collection = `@index:${name}`
        this.collection(collection)
        this.write(collection, JSON.stringify(key), value)
        const row = this.header(collection, JSON.stringify(key))!
        return JSON.stringify({
          collection,
          key: JSON.stringify(key),
          incarnation: Number(row.incarnation),
          path: []
        })
      },
      decode: <T>(json: string): T => {
        const location: JournalSqlValueLocation = JSON.parse(json)
        const value = this.load(location)
        this.objects.observe(value, location)
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: index procedures decode the typed values they captured in their own collection.
        return value as T
      },
      forget: (name, key) => {
        const collection = `@index:${name}`
        if (key === undefined) {
          this.clear(collection)
        } else {
          this.delete(collection, JSON.stringify(key))
        }
      }
    })
  }

  collection(name: string): void {
    this.scope.db
      .prepare(`INSERT OR IGNORE INTO journal_proj_collections
      (session_id, generation, collection) VALUES (?, ?, ?)`)
      .run(...this.scope.prefix, name)
  }

  size(collection: string): number {
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
    const row = this.scope.db
      .prepare(`SELECT ordinal, incarnation FROM journal_proj_values
      WHERE session_id=? AND generation=? AND collection=? AND entry_key=?`)
      .get(...this.scope.prefix, collection, key)
    return row && this.scope.examined(row)
  }

  read<V>(collection: string, key: string): V | undefined {
    const row = this.header(collection, key)
    if (!row) {
      return undefined
    }
    const location = { collection, key, incarnation: Number(row.incarnation), path: [] }
    const value = this.load(location)
    this.objects.observe(value, location)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each typed keyed view owns the values written under its collection name.
    return value as V
  }

  write(collection: string, key: string, value: unknown): void {
    const before = this.header(collection, key)
    const previous = before && {
      collection,
      key,
      incarnation: Number(before.incarnation),
      path: []
    }
    const source =
      typeof value === 'object' && value !== null ? this.objects.locations.get(value) : undefined
    const same = previous && source && this.load(previous) === this.load(source)
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
        encoded.json
      )
    this.references.replace(location, encoded.refs)
    const stored = source ? this.load(source) : this.objects.track(value, location)
    this.loaded.set(journalSqlLocationKey(location), stored)
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
    this.touch(location, false, true)
    return true
  }

  clear(collection: string): void {
    const rows = this.scope.db
      .prepare(`SELECT entry_key FROM journal_proj_values
      WHERE session_id=? AND generation=? AND collection=? ORDER BY ordinal`)
      .all(...this.scope.prefix, collection)
    for (const row of rows) {
      this.scope.examined(row)
      this.delete(collection, String(row.entry_key))
    }
  }

  flush(): void {
    for (const node of this.objects.dirty) {
      this.flushLocation(node.location)
    }
  }

  untracked = (_key: string, value: unknown): unknown => this.objects.untracked(value)

  changes(reset = false): JournalEntryChange[] {
    const changes = [...this.pending.values()].map(({ location, reinsert }) => {
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
    const key = JSON.stringify([location.collection, location.key])
    if (reinsert) {
      this.pending.delete(key)
    }
    const before = this.pending.get(key)
    this.pending.set(key, { location, reinsert: deleted ? false : reinsert || !!before?.reinsert })
  }

  private load(location: JournalSqlValueLocation, json?: unknown): unknown {
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
      const value = decodeJournalSqlValue(this.scope.decode(encoded), (ref) => this.load(ref))
      const reference =
        typeof value === 'object' && value !== null && this.objects.locations.has(value)
      this.loaded.set(key, reference ? value : this.objects.track(value, { ...location, path: [] }))
    }
    return readJournalSqlReferencePath(this.loaded.get(key), location.path)
  }

  private flushLocation(location: JournalSqlValueLocation): void {
    const node = this.objects.tracked.get(journalSqlLocationKey(location))
    if (!node || !this.objects.dirty.delete(node)) {
      return
    }
    const encoded = encodeJournalSqlValue(node.raw, node.location, (object) =>
      this.objects.locations.get(object)
    )
    const updated = this.scope.db
      .prepare(`UPDATE journal_proj_values SET value_json=?
      WHERE session_id=? AND generation=? AND collection=? AND entry_key=? AND incarnation=?`)
      .run(
        encoded.json,
        ...this.scope.prefix,
        location.collection,
        location.key,
        location.incarnation
      )
    if (!updated.changes) {
      const snapshot = this.scope.db
        .prepare(`UPDATE journal_proj_value_snapshots SET value_json=?
        WHERE session_id=? AND generation=? AND collection=? AND entry_key=? AND incarnation=?`)
        .run(
          encoded.json,
          ...this.scope.prefix,
          location.collection,
          location.key,
          location.incarnation
        )
      if (!snapshot.changes) {
        return
      }
    }
    this.references.replace(location, encoded.refs)
  }
}
