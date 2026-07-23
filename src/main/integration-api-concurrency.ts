export const INTEGRATION_API_MAX_WAITERS = 1024

export class IntegrationApiConcurrencyGate {
  private running = 0
  private readonly waiters: (() => void)[] = []

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxWaiters = INTEGRATION_API_MAX_WAITERS
  ) {}

  acquire(): Promise<void> {
    if (this.running < this.maxConcurrent) {
      this.running += 1
      return Promise.resolve()
    }
    if (this.waiters.length >= this.maxWaiters) {
      return Promise.reject(
        new Error('Integration API request queue is full; retry after current requests finish.')
      )
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.running += 1
        resolve()
      })
    })
  }

  release(): void {
    this.running = Math.max(0, this.running - 1)
    this.waiters.shift()?.()
  }
}
