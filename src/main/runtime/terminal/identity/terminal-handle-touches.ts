/** Names the handle each identity write touches (null: any of them), for owners waiting on a few handles. */
export class TerminalHandleTouches {
  private readonly listeners = new Set<(handle: string | null) => void>()

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

  /** Touches the handles bound to keys that are leaving. */
  touchDropped(
    keys: Iterable<string>,
    kept: ReadonlyMap<string, unknown>,
    bindings: ReadonlyMap<string, string>
  ): void {
    for (const key of this.listeners.size > 0 ? keys : []) {
      if (!kept.has(key)) {
        this.touch(bindings.get(key))
      }
    }
  }
}
