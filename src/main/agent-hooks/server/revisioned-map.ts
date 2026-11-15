/** Revision tracking avoids diffing the map. */
export class RevisionedMap<K, V> extends Map<K, V> {
  constructor(private readonly tracksDirtyKeys: () => boolean = () => true) {
    super()
  }

  revision = 0
  readonly dirtyKeys = new Set<K>()

  override set(key: K, value: V): this {
    this.revision++
    if (this.tracksDirtyKeys()) {
      this.dirtyKeys.add(key)
    }
    return super.set(key, value)
  }

  /** Stores value but bumps revision only when `same` rejects the prior value. */
  setIfChanged(key: K, value: V, same: (prior: V, next: V) => boolean = Object.is): this {
    const prior = super.get(key)
    if (prior !== undefined && same(prior, value)) {
      return super.set(key, value)
    }
    return this.set(key, value)
  }

  override delete(key: K): boolean {
    const deleted = super.delete(key)
    if (deleted) {
      this.revision++
      if (this.tracksDirtyKeys()) {
        this.dirtyKeys.add(key)
      }
    }
    return deleted
  }

  override clear(): void {
    if (this.size > 0) {
      this.revision++
      for (const key of this.keys()) {
        if (this.tracksDirtyKeys()) {
          this.dirtyKeys.add(key)
        }
      }
    }
    super.clear()
  }
}
