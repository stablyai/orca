import type { JournalKeyedMap, JournalKeyedSet } from './journal-keyed-storage'

// Memory folds and their drafts own iterable containers; opaque SQL views must use named queries.
export function memoryJournalMap<K, V>(value: JournalKeyedMap<K, V>): Map<K, V> {
  if (!(value instanceof Map)) {
    throw new Error('This operation requires an in-memory journal map')
  }
  return value
}

export function memoryJournalSet<T>(value: JournalKeyedSet<T>): Set<T> {
  if (!(value instanceof Set)) {
    throw new Error('This operation requires an in-memory journal set')
  }
  return value
}
