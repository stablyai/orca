export class StructuredAgentSessionTaskQueue {
  private readonly chains = new Map<string, Promise<unknown>>()
  private readonly attaching = new Set<Promise<unknown>>()

  serialize<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const prior = this.chains.get(sessionId) ?? Promise.resolve()
    const next = prior.then(task, task)
    this.chains.set(
      sessionId,
      next.catch(() => undefined)
    )
    return next
  }

  trackAttach<T>(operation: Promise<T>): Promise<T> {
    this.attaching.add(operation)
    void operation.then(
      () => this.attaching.delete(operation),
      () => this.attaching.delete(operation)
    )
    return operation
  }

  async drainAttaches(): Promise<void> {
    while (this.attaching.size > 0) {
      await Promise.allSettled(this.attaching)
    }
  }
}
