/** Names the handle each identity write touches (null: any of them), for owners waiting on a few handles. */
export class TerminalHandleTouches {
  private readonly listeners = new Set<(handle: string | null) => void>()
  /** Counts graph writes that dropped a leaf, so pane-closed checks run only after one. */
  leafDrops = 0

  listen(listener: (handle: string | null) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  touch(handle: string | null | undefined): void {
    if (handle === undefined) {
      return
    }
    for (const listener of this.listeners) {
      listener(handle)
    }
  }

  /** A graph replacement that kept fewer leaves than it had touches the leaving keys' handles. */
  leavesReplaced(
    previous: ReadonlyMap<string, unknown>,
    kept: number,
    next: ReadonlyMap<string, unknown>,
    bindings: ReadonlyMap<string, string>
  ): void {
    if (kept >= previous.size) {
      return
    }
    this.leafDrops += 1
    for (const key of this.listeners.size > 0 ? previous.keys() : []) {
      if (!next.has(key)) {
        this.touch(bindings.get(key))
      }
    }
  }

  leafRemoved(existed: boolean, handle: string | undefined): void {
    if (existed) {
      this.leafDrops += 1
      this.touch(handle)
    }
  }

  leavesCleared(): void {
    this.leafDrops += 1
    this.touch(null)
  }
}
