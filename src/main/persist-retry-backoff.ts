const RETRY_DELAYS_MS = [100, 1_000, 5_000, 30_000] as const

/** Retries a failed persist on a short backoff; after the last delay it waits for the next mutation. */
export class PersistRetryBackoff {
  private timer: ReturnType<typeof setTimeout> | null = null
  private attempt = 0

  constructor(private readonly retry: () => void) {}

  schedule(): void {
    if (this.timer || this.attempt >= RETRY_DELAYS_MS.length) {
      return
    }
    this.timer = setTimeout(() => {
      this.timer = null
      this.retry()
    }, RETRY_DELAYS_MS[this.attempt])
    this.attempt += 1
    this.timer.unref?.()
  }

  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.attempt = 0
  }
}
