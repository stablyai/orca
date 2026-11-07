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
  for (const key of context.tables.for(collection).keys()) {
    context.delete(collection, key)
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
  for (const key of context.tables.for(collection).keys(limit)) {
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
