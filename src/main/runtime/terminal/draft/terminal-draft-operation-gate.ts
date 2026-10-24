/** Serializes one PTY's draft operations and fences tasks that outlive their PTY. */
export class TerminalDraftOperationGate {
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly generations = new Map<string, number>()

  generation(ptyId: string): number {
    return this.generations.get(ptyId) ?? 0
  }

  dispose(ptyId: string): void {
    // The queue is not dropped: a pending task must still finish before a replacement PTY writes.
    this.generations.set(ptyId, this.generation(ptyId) + 1)
  }

  async runExclusive<T>(ptyId: string, task: () => Promise<T> | T): Promise<T> {
    const previous = this.queues.get(ptyId) ?? Promise.resolve()
    const next = previous.then(task, task)
    const guarded = next.catch(() => {})
    this.queues.set(ptyId, guarded)
    try {
      return await next
    } finally {
      if (this.queues.get(ptyId) === guarded) {
        this.queues.delete(ptyId)
      }
    }
  }
}
