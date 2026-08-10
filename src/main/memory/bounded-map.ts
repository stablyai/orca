// Why: long-lived `orca serve` and desktop sessions grow process-heap Maps without bound
// (git username cache, session-tab selections, per-pane snapshots). Plain `Map<string, T>`
// keeps every entry alive until process exit; replacing the storage with this primitive
// caps the surface to a configurable maximum while keeping hot-path O(1) reads.

export type BoundedMapOptions<K, V> = {
  /** Hard cap on entries. Setting/changing `maxEntries` on an existing map does not
   *  retroactively shrink it past its current size — it only stops new inserts past the cap. */
  maxEntries: number
  /** Optional insertion-order comparator. Default keeps insertion order; pass
   *  `(a, b) => lastAccessedAt(a) - lastAccessedAt(b)` to get LRU eviction. */
  evictionRank?: (a: readonly [K, V], b: readonly [K, V]) => number
}

// Why: not `implements Map<K, V>` — TS's MapIterator has helper methods (map/filter/take/drop)
// added in recent lib versions and `getOrInsert`/`getOrInsertComputed` are required members,
// which would force the primitive to carry the full Map surface. Callers that need a Map can
// use the default rank; LRU callers accept BoundedMap as a structurally-typed substitute.
export class BoundedMap<K, V> {
  private readonly entries_ = new Map<K, V>()
  private readonly maxEntries: number
  private readonly evictionRank: (a: readonly [K, V], b: readonly [K, V]) => number

  constructor(options: BoundedMapOptions<K, V>) {
    if (!Number.isInteger(options.maxEntries) || options.maxEntries <= 0) {
      throw new RangeError(
        `BoundedMap.maxEntries must be a positive integer, got ${options.maxEntries}`
      )
    }
    this.maxEntries = options.maxEntries
    this.evictionRank = options.evictionRank ?? ((_a, _b) => 0) // default rank: insertion order
  }

  get size(): number {
    return this.entries_.size
  }

  has(key: K): boolean {
    return this.entries_.has(key)
  }

  get(key: K): V | undefined {
    return this.entries_.get(key)
  }

  set(key: K, value: V): this {
    if (this.entries_.has(key)) {
      this.entries_.set(key, value)
      return this
    }
    if (this.entries_.size >= this.maxEntries) {
      this.evictOne()
    }
    this.entries_.set(key, value)
    return this
  }

  delete(key: K): boolean {
    return this.entries_.delete(key)
  }

  clear(): void {
    this.entries_.clear()
  }

  forEach(callback: (value: V, key: K, map: this) => void, thisArg?: unknown): void {
    this.entries_.forEach((value, key) => callback.call(thisArg, value, key, this))
  }

  *entries(): IterableIterator<[K, V]> {
    yield* this.entries_.entries()
  }

  *keys(): IterableIterator<K> {
    yield* this.entries_.keys()
  }

  *values(): IterableIterator<V> {
    yield* this.entries_.values()
  }

  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.entries_.entries()
  }

  get [Symbol.toStringTag](): string {
    return 'BoundedMap'
  }

  /** Build an LRU-style eviction rank using a "last accessed at" timestamp stored in `V`. */
  static lruByTimestamp<V extends { lastAccessedAt: number }>(
    _options: { now?: () => number } = {}
  ): (a: readonly [unknown, V], b: readonly [unknown, V]) => number {
    return (a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt
  }

  private evictOne(): void {
    if (this.entries_.size === 0) {
      return
    }
    // Why: Map iteration is insertion-ordered, so for the default rank (always 0) the first
    // key is the oldest insertion. For LRU, the rank comparison only makes sense against a
    // second entry — compare each candidate against a fixed reference and keep the minimum.
    const all = [...this.entries_]
    if (all.length === 0) {
      return
    }
    let oldestKey: K = all[0][0]
    for (let i = 1; i < all.length; i++) {
      const candidate = all[i]
      if (this.evictionRank(candidate, [oldestKey, this.entries_.get(oldestKey)!]) < 0) {
        oldestKey = candidate[0]
      }
    }
    this.entries_.delete(oldestKey)
  }
}
