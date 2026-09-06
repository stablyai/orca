export class RuntimeWorktreeLifecycleEvents<T> {
  private readonly listeners = new Set<(event: T) => void>()

  on(listener: (event: T) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event: T): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        console.error('[runtime] worktree lifecycle listener threw', error)
      }
    }
  }
}
