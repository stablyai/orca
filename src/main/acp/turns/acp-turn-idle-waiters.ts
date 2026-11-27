/** Callers waiting for the turn to go idle; an abort releases one early. */
export class AcpTurnIdleWaiters {
  private readonly waiters = new Set<() => void>()

  /** Resolves at the first wake `idle()` agrees with, or on abort. */
  wait(idle: () => boolean, signal?: AbortSignal): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>()
    const finish = (): void => {
      this.waiters.delete(wake)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    const wake = (): void => {
      if (idle()) {
        finish()
      }
    }
    this.waiters.add(wake)
    signal?.addEventListener('abort', finish, { once: true })
    return promise
  }

  wake(): void {
    for (const wake of this.waiters) {
      wake()
    }
  }
}
