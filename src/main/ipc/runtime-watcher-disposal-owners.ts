import type { RuntimeWatcherPoolSupervisor } from './runtime-watcher-pool-state'

type Attempt = { pending: Promise<void> | null; failure?: unknown }

export class RuntimeWatcherDisposalOwners {
  private readonly retained = new Map<RuntimeWatcherPoolSupervisor, Attempt>()
  private shutdown: Promise<void> | null = null

  retire(owner: RuntimeWatcherPoolSupervisor): void {
    if (!this.retained.has(owner)) {
      this.start(owner)
    }
  }

  disposeAndWait(disposePool: () => void): Promise<void> {
    if (this.shutdown) {
      return this.shutdown
    }
    const retry = [...this.retained].filter(([, attempt]) => !attempt.pending)
    const completion = Promise.withResolvers<void>()
    this.shutdown = completion.promise
    const failures: unknown[] = []
    try {
      disposePool()
    } catch (error) {
      failures.push(error)
    }
    for (const [owner, attempt] of retry) {
      if (this.retained.get(owner) === attempt) {
        this.start(owner)
      }
    }
    const pending = [...this.retained.values()].map(
      (attempt) => attempt.pending ?? Promise.reject(attempt.failure)
    )
    void Promise.allSettled(pending).then((results) => {
      for (const result of results) {
        if (result.status === 'rejected') {
          failures.push(result.reason)
        }
      }
      this.shutdown = null
      if (failures.length > 0) {
        completion.reject(new AggregateError(failures, 'watcher_pool_shutdown_incomplete'))
      } else {
        completion.resolve()
      }
    })
    return completion.promise
  }

  private start(owner: RuntimeWatcherPoolSupervisor): void {
    const completion = Promise.withResolvers<void>()
    const attempt: Attempt = { pending: completion.promise }
    this.retained.set(owner, attempt)
    void completion.promise.catch(() => {})
    const failed = (error: unknown): void => {
      attempt.pending = null
      attempt.failure = error
      completion.reject(error)
    }
    try {
      if (!owner.disposeAndWait) {
        owner.dispose()
        throw new Error('watcher_supervisor_awaited_disposal_unavailable')
      }
      void owner.disposeAndWait().then(() => {
        if (this.retained.get(owner) === attempt) {
          this.retained.delete(owner)
        }
        completion.resolve()
      }, failed)
    } catch (error) {
      failed(error)
    }
  }
}
