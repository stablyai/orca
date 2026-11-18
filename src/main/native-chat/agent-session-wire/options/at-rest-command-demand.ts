import type { PrioritySemaphore } from '../../../../shared/concurrency/priority-semaphore'

/** A modern request can take over queued eager work, but joins work already admitted. */
export class AtRestCommandDemand {
  private readonly listeners = new Set<() => void>()

  constructor(public independent: boolean) {}

  /** Called when an explicit read joins this work; returns the unsubscribe. */
  onRequest(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  request(): void {
    this.independent = true
    this.listeners.forEach((listener) => listener())
  }

  async acquire(pool: PrioritySemaphore, signal: AbortSignal): Promise<() => void> {
    if (this.independent) {
      return () => {}
    }
    const queued = new AbortController()
    const promote = () => queued.abort()
    this.listeners.add(promote)
    try {
      const release = await pool.acquire(0, AbortSignal.any([signal, queued.signal]))
      if (this.independent) {
        release()
        return () => {}
      }
      return release
    } catch (error) {
      if (this.independent && !signal.aborted) {
        return () => {}
      }
      throw error
    } finally {
      this.listeners.delete(promote)
    }
  }
}
