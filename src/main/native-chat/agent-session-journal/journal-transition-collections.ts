// Overlay collections leave the live containers untouched until their transaction commits.

export type JournalEntryChange = {
  path: string
  key: unknown
  deleted: boolean
  reinsert: boolean
  value: unknown
}

export type JournalDraftAccess = {
  wrap: <T>(value: T, changed: () => void, path: string) => T
  assign: (value: unknown) => void
  finish: <T>(value: T) => T
  defer: (apply: () => void) => void
}

export class JournalDraftMap<K, V> extends Map<K, V> {
  private readonly writes = new Map<K, V>()
  private readonly removed = new Set<K>()
  private readonly inserted = new Set<K>()
  private readonly touched = new Set<K>()
  private readonly pending = new Set<K>()
  private readonly recreated = new Set<K>()

  constructor(
    private readonly source: Map<K, V>,
    private readonly access: JournalDraftAccess,
    private readonly changed: () => void,
    readonly path: string
  ) {
    super()
  }

  override get size(): number {
    return this.source.size - this.removed.size + this.inserted.size
  }

  override has(key: K): boolean {
    return this.inserted.has(key) || (!this.removed.has(key) && this.source.has(key))
  }

  override get(key: K): V | undefined {
    return this.has(key) ? this.draft(key) : undefined
  }

  override set(key: K, value: V): this {
    if (!this.has(key)) {
      this.inserted.add(key)
      this.recreated.add(key)
      // A (re)created key moves to the end of both orders, as the live map's re-insert does.
      this.touched.delete(key)
      this.pending.delete(key)
    }
    this.access.assign(value)
    this.writes.set(key, value)
    this.touch(key)
    return this
  }

  override delete(key: K): boolean {
    if (!this.has(key)) {
      return false
    }
    if (this.source.has(key)) {
      this.removed.add(key)
    }
    this.inserted.delete(key)
    this.recreated.delete(key)
    this.writes.delete(key)
    this.touch(key)
    return true
  }

  override clear(): void {
    for (const key of this.keys()) {
      this.delete(key)
    }
  }

  override *keys(): MapIterator<K> {
    for (const key of this.source.keys()) {
      if (!this.removed.has(key)) {
        yield key
      }
    }
    yield* this.inserted
  }

  override *values(): MapIterator<V> {
    for (const key of this.keys()) {
      yield this.draft(key)
    }
  }

  override *entries(): MapIterator<[K, V]> {
    for (const key of this.keys()) {
      yield [key, this.draft(key)]
    }
  }

  override [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries()
  }

  override forEach(callback: (value: V, key: K, map: Map<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this) {
      callback.call(thisArg, value, key, this)
    }
  }

  changes(reset = false): JournalEntryChange[] {
    const changes = [...this.pending].map((key) => ({
      path: this.path,
      key,
      deleted: !this.has(key),
      reinsert: this.recreated.has(key),
      value: this.get(key)
    }))
    if (reset) {
      this.pending.clear()
      this.recreated.clear()
    }
    return changes
  }

  finish(): Map<K, V> {
    const changes = [...this.touched].map((key) => ({
      key,
      reinsert: this.inserted.has(key),
      kept: this.has(key) ? { value: this.access.finish(this.draft(key)) } : null
    }))
    this.access.defer(() => {
      for (const { key, reinsert, kept } of changes) {
        if (!kept || reinsert) {
          this.source.delete(key)
        }
        if (kept) {
          this.source.set(key, kept.value)
        }
      }
    })
    return this.source
  }

  /** Only for present keys; a present entry may hold undefined. */
  private draft(key: K): V {
    const stored = this.writes.has(key) ? this.writes.get(key) : this.source.get(key)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: callers pass only keys has() reports present, so the stored value is a V even when V includes undefined.
    return this.access.wrap(stored as V, () => this.touch(key), `${this.path}.*`)
  }

  private touch(key: K): void {
    this.touched.add(key)
    this.pending.add(key)
    this.changed()
  }
}

export class JournalDraftSet<T> extends Set<T> {
  private readonly removed = new Set<T>()
  private readonly inserted = new Set<T>()
  private readonly touched = new Set<T>()
  private readonly pending = new Set<T>()
  private readonly recreated = new Set<T>()

  constructor(
    private readonly source: Set<T>,
    private readonly access: JournalDraftAccess,
    private readonly changed: () => void,
    readonly path: string
  ) {
    super()
  }

  override get size(): number {
    return this.source.size - this.removed.size + this.inserted.size
  }
  override has(value: T): boolean {
    return this.inserted.has(value) || (!this.removed.has(value) && this.source.has(value))
  }
  override add(value: T): this {
    if (!this.has(value)) {
      this.inserted.add(value)
      this.recreated.add(value)
      this.pending.delete(value)
      this.pending.add(value)
      this.touched.delete(value)
      this.touched.add(value)
      this.changed()
    }
    return this
  }
  override delete(value: T): boolean {
    if (!this.has(value)) {
      return false
    }
    if (this.source.has(value)) {
      this.removed.add(value)
    }
    this.inserted.delete(value)
    this.recreated.delete(value)
    this.pending.add(value)
    this.touched.add(value)
    this.changed()
    return true
  }
  override clear(): void {
    for (const value of this) {
      this.delete(value)
    }
  }
  override *values(): SetIterator<T> {
    for (const value of this.source) {
      if (!this.removed.has(value)) {
        yield value
      }
    }
    yield* this.inserted
  }
  override keys(): SetIterator<T> {
    return this.values()
  }
  override *entries(): SetIterator<[T, T]> {
    for (const value of this.values()) {
      yield [value, value]
    }
  }
  override [Symbol.iterator](): SetIterator<T> {
    return this.values()
  }
  override forEach(callback: (value: T, key: T, set: Set<T>) => void, thisArg?: unknown): void {
    for (const value of this) {
      callback.call(thisArg, value, value, this)
    }
  }
  changes(reset = false): JournalEntryChange[] {
    const changes = [...this.pending].map((key) => ({
      path: this.path,
      key,
      deleted: !this.has(key),
      reinsert: this.recreated.has(key),
      value: key
    }))
    if (reset) {
      this.pending.clear()
      this.recreated.clear()
    }
    return changes
  }
  finish(): Set<T> {
    const changes = [...this.touched].map((value) => ({
      value,
      deleted: !this.has(value),
      reinsert: this.inserted.has(value)
    }))
    this.access.defer(() => {
      for (const { value, deleted, reinsert } of changes) {
        if (deleted || reinsert) {
          this.source.delete(value)
        }
        if (!deleted) {
          this.source.add(value)
        }
      }
    })
    return this.source
  }
}
