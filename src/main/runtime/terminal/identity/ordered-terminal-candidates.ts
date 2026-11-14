/** Ordered membership only; the canonical source still owns records and validation. */
export class OrderedTerminalCandidates {
  private readonly entries = new Map<string, { keys: readonly string[]; position: bigint }>()
  private readonly byKey = new Map<string, string[]>()
  private nextPosition = 0n

  first(handle: string): string | undefined {
    return this.byKey.get(handle)?.[0]
  }

  matching(keys: readonly string[]): string[] {
    return [...new Set(keys.flatMap((key) => this.byKey.get(key) ?? []))].sort((a, b) => {
      const left = this.entries.get(a)!.position
      const right = this.entries.get(b)!.position
      return left < right ? -1 : left > right ? 1 : 0
    })
  }

  set(id: string, key: string | readonly string[]): void {
    const keys = typeof key === 'string' ? [key] : key
    const previous = this.entries.get(id)
    if (
      previous?.keys.length === keys.length &&
      previous.keys.every((value, index) => value === keys[index])
    ) {
      return
    }
    const position = previous?.position ?? this.nextPosition++
    this.delete(id)
    this.entries.set(id, { keys, position })
    for (const address of keys) {
      const bucket = this.byKey.get(address) ?? []
      let index = bucket.length
      while (index > 0 && this.entries.get(bucket[index - 1])!.position > position) {
        index--
      }
      bucket.splice(index, 0, id)
      this.byKey.set(address, bucket)
    }
  }

  delete(id: string): void {
    const previous = this.entries.get(id)
    if (!previous) {
      return
    }
    for (const key of previous.keys) {
      const bucket = this.byKey.get(key)!
      bucket.splice(bucket.indexOf(id), 1)
      if (bucket.length === 0) {
        this.byKey.delete(key)
      }
    }
    this.entries.delete(id)
  }

  clear(): void {
    this.entries.clear()
    this.byKey.clear()
  }
}
