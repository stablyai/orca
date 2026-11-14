export class TerminalHistoryMutationTracker {
  private pending = new Map<string, Set<Promise<unknown>>>()

  track<T>(sessionId: string, operation: Promise<T>): Promise<T> {
    const mutations = this.pending.get(sessionId) ?? new Set<Promise<unknown>>()
    mutations.add(operation)
    this.pending.set(sessionId, mutations)
    void operation.then(
      () => this.finish(sessionId, operation),
      () => this.finish(sessionId, operation)
    )
    return operation
  }

  async wait(sessionId: string): Promise<void> {
    while (this.pending.has(sessionId)) {
      await Promise.allSettled(this.pending.get(sessionId)!)
    }
  }

  private finish(sessionId: string, operation: Promise<unknown>): void {
    const mutations = this.pending.get(sessionId)
    mutations?.delete(operation)
    if (mutations?.size === 0) {
      this.pending.delete(sessionId)
    }
  }
}
