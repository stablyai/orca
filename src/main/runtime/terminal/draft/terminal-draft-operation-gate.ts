/** Serializes one PTY's draft operations and fences tasks that outlive their PTY. */
export class TerminalDraftOperationGate {
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly generations = new Map<string, number>()
  private readonly disposed = new Set<string>()

  generation(ptyId: string): number {
    return this.generations.get(ptyId) ?? 0
  }

  dispose(ptyId: string): void {
    // With no queued work there is nothing to fence; keeping the entry would leak per dead PTY.
    if (!this.queues.has(ptyId)) {
      this.generations.delete(ptyId)
      this.disposed.delete(ptyId)
      return
    }
    // The queue is not dropped: a pending task must still finish before a replacement PTY writes.
    this.generations.set(ptyId, this.generation(ptyId) + 1)
    this.disposed.add(ptyId)
  }

  async runExclusive<T>(ptyId: string, task: (generation: number) => Promise<T> | T): Promise<T> {
    const generation = this.generation(ptyId)
    const previous = this.queues.get(ptyId) ?? Promise.resolve()
    const run = (): Promise<T> | T => task(generation)
    const next = previous.then(run, run)
    const guarded = next.catch(() => {})
    this.queues.set(ptyId, guarded)
    try {
      return await next
    } finally {
      if (this.queues.get(ptyId) === guarded) {
        this.queues.delete(ptyId)
        // Why: all work for this generation drained, so the per-PTY fence no longer needs a slot.
        if (this.disposed.delete(ptyId)) {
          this.generations.delete(ptyId)
        }
      }
    }
  }
}
