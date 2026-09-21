import { runKeyedSerializedOperation } from '../../cli/keyed-promise-queue'

export class StructuredAgentSessionTaskQueue {
  private readonly chains = new Map<string, Promise<void>>()
  private readonly attaching = new Set<Promise<unknown>>()

  serialize<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    return runKeyedSerializedOperation(this.chains, sessionId, task)
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
