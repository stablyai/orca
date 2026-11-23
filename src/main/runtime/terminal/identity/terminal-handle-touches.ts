/** Names the handle each identity write touches (null: any of them), and the pane leaves a graph drops,
 *  for owners waiting on a few handles. */
export class TerminalHandleTouches {
  private readonly listeners = new Set<(handle: string | null) => void>()
  private readonly leafListeners = new Set<(leafId: string) => void>()

  listen(
    listener: (handle: string | null) => void,
    onLeafDropped: (leafId: string) => void
  ): () => void {
    this.listeners.add(listener)
    this.leafListeners.add(onLeafDropped)
    return () => {
      this.listeners.delete(listener)
      this.leafListeners.delete(onLeafDropped)
    }
  }

  touch(handle: string | null | undefined): void {
    if (handle === undefined) {
      return
    }
    for (const listener of this.listeners) {
      listener(handle)
    }
  }

  /** A graph replacement that kept fewer leaves than it had names each leaving leaf and its handle. */
  leavesReplaced(
    previous: ReadonlyMap<string, { leafId: string }>,
    kept: number,
    next: ReadonlyMap<string, unknown>,
    bindings: ReadonlyMap<string, string>
  ): void {
    let dropped = this.listeners.size > 0 ? previous.size - kept : 0
    for (const [key, leaf] of dropped > 0 ? previous : []) {
      if (!next.has(key)) {
        this.leafRemoved(leaf, bindings.get(key))
        if (--dropped === 0) {
          return
        }
      }
    }
  }

  leafRemoved(leaf: { leafId: string } | undefined, handle: string | undefined): void {
    if (leaf) {
      this.touch(handle)
      for (const listener of this.leafListeners) {
        listener(leaf.leafId)
      }
    }
  }

  leavesCleared(): void {
    this.touch(null)
  }
}
