const MAX_TIMER_MS = 2_147_483_647

/** Paced spawn requests waiting for a slot, a deadline, or their caller's cancellation. */
export class TerminalSpawnWaiters {
  private readonly waiters = new Set<() => void>()

  constructor(private readonly now: () => number) {}

  get size(): number {
    return this.waiters.size
  }

  waitForChange(untilMs: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', done)
        this.waiters.delete(done)
        resolve()
      }
      const delayMs = Number.isFinite(untilMs) ? Math.max(0, untilMs - this.now()) : MAX_TIMER_MS
      const timer = setTimeout(done, Math.min(delayMs, MAX_TIMER_MS))
      timer.unref?.()
      this.waiters.add(done)
      signal?.addEventListener('abort', done, { once: true })
    })
  }

  wakeAll(): void {
    for (const wake of this.waiters) {
      wake()
    }
  }
}
