// Wakes waiters when a reconcile starts or a fence lands, so they re-check promptly.
export class RelayReconcileSignal {
  private readonly waiters = new Set<() => void>()

  next(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        this.waiters.delete(done)
        resolve()
      }
      const timer = setTimeout(done, timeoutMs)
      this.waiters.add(done)
    })
  }

  notify(): void {
    for (const wake of this.waiters) {
      wake()
    }
  }
}
