/** Ordered membership only; the canonical source still owns records and validation. */
export class TerminalIncarnationCandidates {
  private readonly entries = new Map<string, { handle: string; position: bigint }>()
  private readonly byHandle = new Map<string, string[]>()
  private nextPosition = 0n

  first(handle: string): string | undefined {
    return this.byHandle.get(handle)?.[0]
  }

  set(id: string, handle: string): void {
    const previous = this.entries.get(id)
    if (previous?.handle === handle) {
      return
    }
    const position = previous?.position ?? this.nextPosition++
    this.delete(id)
    const bucket = this.byHandle.get(handle) ?? []
    let index = bucket.length
    while (index > 0 && this.entries.get(bucket[index - 1])!.position > position) {
      index--
    }
    bucket.splice(index, 0, id)
    this.entries.set(id, { handle, position })
    this.byHandle.set(handle, bucket)
  }

  delete(id: string): void {
    const previous = this.entries.get(id)
    if (!previous) {
      return
    }
    const bucket = this.byHandle.get(previous.handle)!
    bucket.splice(bucket.indexOf(id), 1)
    if (bucket.length === 0) {
      this.byHandle.delete(previous.handle)
    }
    this.entries.delete(id)
  }

  clear(): void {
    this.entries.clear()
    this.byHandle.clear()
  }
}
