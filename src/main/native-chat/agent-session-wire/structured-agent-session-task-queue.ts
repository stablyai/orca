import { runKeyedSerializedOperation } from '../../cli/keyed-promise-queue'

/** Fire-and-forget work that teardown has to wait out; entries drop themselves once settled. */
export class PendingOperationDrain {
  private readonly pending = new Set<Promise<unknown>>()

  track<T>(operation: Promise<T>): Promise<T> {
    this.pending.add(operation)
    const forget = (): void => void this.pending.delete(operation)
    void operation.then(forget, forget)
    return operation
  }

  /** Re-checked, because work settling here can enqueue more of it. */
  async drain(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled(this.pending)
      if (this.pending.size > 0) {
        // Yield a macrotask, so a caller's timeout can still fire between rounds.
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    }
  }
}

export class StructuredAgentSessionTaskQueue {
  private readonly chains = new Map<string, Promise<void>>()
  private readonly attaches = new PendingOperationDrain()

  serialize<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    return runKeyedSerializedOperation(this.chains, sessionId, task)
  }

  trackAttach<T>(operation: Promise<T>): Promise<T> {
    return this.attaches.track(operation)
  }

  drainAttaches(): Promise<void> {
    return this.attaches.drain()
  }
}
