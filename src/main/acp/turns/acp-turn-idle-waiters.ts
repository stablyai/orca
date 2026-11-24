/** Callers waiting for the running prompt to end; Stop or an abort releases one early. */
export class AcpTurnIdleWaiters {
  private readonly waiters = new Set<() => void>()

  wait(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const wake = (): void => {
        this.waiters.delete(wake)
        signal?.removeEventListener('abort', wake)
        resolve()
      }
      this.waiters.add(wake)
      signal?.addEventListener('abort', wake, { once: true })
    })
  }

  wake(): void {
    for (const wake of this.waiters) {
      wake()
    }
    this.waiters.clear()
  }
}
