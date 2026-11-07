export type JournalKeyedRead<K, V> = {
  get: (key: K) => V | undefined
  has: (key: K) => boolean
}

export type JournalKeyedMap<K, V> = JournalKeyedRead<K, V> & {
  readonly size: number
  set: (key: K, value: V) => unknown
  delete: (key: K) => boolean
  clear: () => void
}

export type JournalKeyedSet<T> = {
  readonly size: number
  has: (value: T) => boolean
  add: (value: T) => unknown
  delete: (value: T) => boolean
  clear: () => void
}
