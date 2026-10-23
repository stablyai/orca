/** Map whose `revision` advances on every mutation, so a reader can detect change without diffing. */
export class RevisionedMap<K, V> extends Map<K, V> {
  revision = 0

  override set(key: K, value: V): this {
    this.revision++
    return super.set(key, value)
  }

  override delete(key: K): boolean {
    const deleted = super.delete(key)
    if (deleted) {
      this.revision++
    }
    return deleted
  }

  override clear(): void {
    if (this.size > 0) {
      this.revision++
    }
    super.clear()
  }
}
