import type { JournalKeyedMap, JournalKeyedSet } from './journal-keyed-storage'
import type { JournalSqlValueContext } from './journal-sql-value-context'

export function journalSqlEntryKey(key: unknown): string {
  if (typeof key !== 'string' && !(typeof key === 'number' && Number.isFinite(key))) {
    throw new Error('Unsupported journal projection key')
  }
  return JSON.stringify(key)
}

export function clearJournalSqlCollection(
  context: JournalSqlValueContext,
  collection: string
): void {
  const { scope } = context
  const entity = context.tables.for(collection)
  if (entity) {
    for (const key of entity.keys()) {
      context.delete(collection, key)
    }
    return
  }
  const rows = scope.db
    .prepare(`SELECT entry_key FROM journal_proj_values
    WHERE session_id=? AND generation=? AND collection=? ORDER BY ordinal`)
    .all(...scope.prefix, collection)
  for (const row of rows) {
    scope.examined(row)
    context.delete(collection, String(row.entry_key))
  }
}

export class JournalSqlKeyedMap<K, V> implements JournalKeyedMap<K, V> {
  constructor(
    private readonly context: JournalSqlValueContext,
    readonly collection: string
  ) {}

  get size(): number {
    return this.context.size(this.collection)
  }
  get(key: K): V | undefined {
    return this.context.read<V>(this.collection, journalSqlEntryKey(key))
  }
  has(key: K): boolean {
    return !!this.context.header(this.collection, journalSqlEntryKey(key))
  }
  set(key: K, value: V): this {
    this.context.write(this.collection, journalSqlEntryKey(key), value)
    return this
  }
  delete(key: K): boolean {
    return this.context.delete(this.collection, journalSqlEntryKey(key))
  }
  clear(): void {
    this.context.clear(this.collection)
  }
}

export class JournalSqlKeyedSet<T> implements JournalKeyedSet<T> {
  private readonly map: JournalSqlKeyedMap<T, T>
  constructor(context: JournalSqlValueContext, collection: string) {
    this.map = new JournalSqlKeyedMap(context, collection)
  }
  get collection(): string {
    return this.map.collection
  }
  get size(): number {
    return this.map.size
  }
  has(value: T): boolean {
    return this.map.has(value)
  }
  add(value: T): this {
    if (!this.has(value)) {
      this.map.set(value, value)
    }
    return this
  }
  delete(value: T): boolean {
    return this.map.delete(value)
  }
  clear(): void {
    this.map.clear()
  }
}

/** Insertion order, as a Map iterates: keys are fixed at the call; entries deleted meanwhile are skipped. */
export function* journalSqlOrderedKeys(
  context: JournalSqlValueContext,
  collection: string,
  limit = -1
): Generator<string> {
  const { scope } = context
  const entity = context.tables.for(collection)
  if (entity) {
    for (const key of entity.keys(limit)) {
      if (limit === 1 || context.header(collection, key)) {
        yield key
      }
    }
    return
  }
  const rows = scope.db
    .prepare(`SELECT entry_key FROM journal_proj_values
    WHERE session_id=? AND generation=? AND collection=? ORDER BY ordinal LIMIT ?`)
    .all(...scope.prefix, collection, limit)
  for (const row of rows) {
    scope.examined(row)
    const key = String(row.entry_key)
    if (limit === 1 || context.header(collection, key)) {
      yield key
    }
  }
}

export function* journalSqlOrderedValues<V>(
  context: JournalSqlValueContext,
  collection: string,
  limit = -1
): Generator<V> {
  for (const key of journalSqlOrderedKeys(context, collection, limit)) {
    yield context.read<V>(collection, key)!
  }
}
