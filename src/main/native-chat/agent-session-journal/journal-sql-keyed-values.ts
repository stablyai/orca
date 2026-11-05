import type { JournalKeyedMap, JournalKeyedSet } from './journal-keyed-storage'
import type { JournalSqlValueContext } from './journal-sql-value-context'

export function journalSqlEntryKey(key: unknown): string {
  if (typeof key !== 'string' && !(typeof key === 'number' && Number.isFinite(key))) {
    throw new Error('Unsupported journal projection key')
  }
  return JSON.stringify(key)
}

export class JournalSqlKeyedMap<K, V> implements JournalKeyedMap<K, V> {
  constructor(
    private readonly context: JournalSqlValueContext,
    private readonly collection: string
  ) {
    context.collection(collection)
  }

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
