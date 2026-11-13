import { RateLimitServiceProviderCycles } from './service-provider-cycles'

type FetchCycle = (signal: AbortSignal) => Promise<void>

export abstract class RateLimitServiceFetchQueue extends RateLimitServiceProviderCycles {
  protected async fetchAll(options?: { force?: boolean }): Promise<void> {
    if (this.isFetching) {
      if (options?.force) {
        this.fullFetchQueued = true
        return this.waitForFetchIdle()
      }
      return
    }
    // Only user-forced refreshes bypass Retry-After; queued reruns are forced.
    return this.runFetchQueue((signal) =>
      this.runFetchAllCycle(signal, { force: options?.force ?? false })
    )
  }

  protected async fetchCodexOnly(options?: { force?: boolean }): Promise<void> {
    if (this.isFetching) {
      if (options?.force) {
        this.codexOnlyFetchQueued = true
        return this.waitForFetchIdle()
      }
      return
    }
    return this.runFetchQueue((signal) => this.runFetchCodexOnlyCycle(signal))
  }

  protected async fetchClaudeOnly(options?: { force?: boolean }): Promise<void> {
    if (this.isFetching) {
      if (options?.force) {
        this.claudeOnlyFetchQueued = true
        return this.waitForFetchIdle()
      }
      return
    }
    return this.runFetchQueue((signal) =>
      this.runFetchClaudeOnlyCycle(signal, { force: options?.force ?? false })
    )
  }

  protected async fetchGrokOnly(options?: { force?: boolean }): Promise<void> {
    if (this.isFetching) {
      if (options?.force) {
        this.grokOnlyFetchQueued = true
        return this.waitForFetchIdle()
      }
      return
    }
    return this.runFetchQueue((signal) => this.runFetchGrokOnlyCycle(signal))
  }

  private async runFetchQueue(first: FetchCycle): Promise<void> {
    this.isFetching = true
    try {
      let cycle: FetchCycle | null = first
      while (cycle) {
        const signal = await this.runWithFetchAbortSignal(cycle)
        if (signal.aborted) {
          break
        }
        // Re-read every flag after each cycle: a request can queue while any cycle runs.
        cycle = this.takeQueuedFetchCycle()
      }
    } finally {
      this.isFetching = false
      this.resolveFetchIdleWaiters()
    }
  }

  private takeQueuedFetchCycle(): FetchCycle | null {
    if (this.fullFetchQueued) {
      this.fullFetchQueued = false
      return (signal) => this.runFetchAllCycle(signal, { force: true })
    }
    if (this.codexOnlyFetchQueued) {
      this.codexOnlyFetchQueued = false
      return (signal) => this.runFetchCodexOnlyCycle(signal)
    }
    if (this.claudeOnlyFetchQueued) {
      this.claudeOnlyFetchQueued = false
      return (signal) => this.runFetchClaudeOnlyCycle(signal, { force: true })
    }
    if (this.grokOnlyFetchQueued) {
      this.grokOnlyFetchQueued = false
      return (signal) => this.runFetchGrokOnlyCycle(signal)
    }
    return null
  }
}
