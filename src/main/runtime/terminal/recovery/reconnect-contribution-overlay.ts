export class ContributionOverlay<K, V> {
  private readonly edits = new Map<K, { value: V } | undefined>()
  private removed = 0
  private added = 0
  constructor(private base?: ContributionOverlay<K, V>) {}
  candidate(): ContributionOverlay<K, V> {
    return new ContributionOverlay(this)
  }
  get(key: K): V | undefined {
    return this.edits.has(key) ? this.edits.get(key)?.value : this.base?.get(key)
  }
  has(key: K): boolean {
    return this.edits.has(key) ? this.edits.get(key) !== undefined : (this.base?.has(key) ?? false)
  }
  set(key: K, value: V): void {
    const before = this.has(key),
      inherited = this.base?.has(key) ?? false
    if (!before) {
      if (inherited) {
        this.removed -= 1
      } else {
        this.added += 1
      }
    }
    this.edits.set(key, { value })
  }
  delete(key: K): void {
    if (!this.has(key)) {
      return
    }
    if (this.base?.has(key)) {
      this.removed += 1
    } else {
      this.added -= 1
    }
    this.edits.set(key, undefined)
  }
  clear(): void {
    this.base = undefined
    this.edits.clear()
    this.removed = 0
    this.added = 0
  }
  get size(): number {
    return (this.base?.size ?? 0) + this.added - this.removed
  }
  *keys(): IterableIterator<K> {
    for (const key of this.base?.keys() ?? []) {
      if (this.has(key)) {
        yield key
      }
    }
    for (const [key, entry] of this.edits) {
      if (entry && !this.base?.has(key)) {
        yield key
      }
    }
  }
  *[Symbol.iterator](): IterableIterator<K> {
    yield* this.keys()
  }
}
