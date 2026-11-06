import { RateLimitServiceProviderCycles } from './service-provider-cycles'

export abstract class RateLimitServiceFetchQueue extends RateLimitServiceProviderCycles {
  /** Shared loop: one cycle, then honor a queued full or same-provider re-run before idling. */
  private async runSingleProviderDrain(
    cycle: (signal: AbortSignal) => Promise<void>,
    queuedFlag: () => boolean,
    clearQueued: () => void
  ): Promise<void> {
    let shouldContinue = true
    while (shouldContinue) {
      const signal = await this.runWithFetchAbortSignal(cycle)
      shouldContinue = false
      if (signal.aborted) {
        break
      }
      if (this.fullFetchQueued) {
        this.fullFetchQueued = false
        const fullSignal = await this.runWithFetchAbortSignal((fetchSignal) =>
          this.runFetchAllCycle(fetchSignal, { force: true })
        )
        if (fullSignal.aborted) {
          break
        }
        continue
      }
      if (queuedFlag()) {
        clearQueued()
        shouldContinue = true
      }
    }
  }

  protected async fetchAll(options?: { force?: boolean }): Promise<void> {
    if (this.isFetching) {
      if (options?.force) {
        this.fullFetchQueued = true
        return this.waitForFetchIdle()
      }
      return
    }
    this.isFetching = true

    try {
      let shouldContinue = true
      // Only user-forced refreshes bypass Retry-After; queued reruns inherit that force.
      let cycleForce = options?.force ?? false
      while (shouldContinue) {
        const signal = await this.runWithFetchAbortSignal((fetchSignal) =>
          this.runFetchAllCycle(fetchSignal, { force: cycleForce })
        )
        shouldContinue = false
        cycleForce = true
        if (signal.aborted) {
          break
        }
        if (this.fullFetchQueued) {
          this.fullFetchQueued = false
          shouldContinue = true
          continue
        }
        if (this.codexOnlyFetchQueued) {
          this.codexOnlyFetchQueued = false
          const codexSignal = await this.runWithFetchAbortSignal((fetchSignal) =>
            this.runFetchCodexOnlyCycle(fetchSignal)
          )
          if (codexSignal.aborted) {
            break
          }
        }
        if (this.claudeOnlyFetchQueued) {
          this.claudeOnlyFetchQueued = false
          const claudeSignal = await this.runWithFetchAbortSignal((fetchSignal) =>
            this.runFetchClaudeOnlyCycle(fetchSignal, { force: true })
          )
          if (claudeSignal.aborted) {
            break
          }
        }
        if (this.grokOnlyFetchQueued) {
          this.grokOnlyFetchQueued = false
          const grokSignal = await this.runWithFetchAbortSignal((fetchSignal) =>
            this.runFetchGrokOnlyCycle(fetchSignal)
          )
          if (grokSignal.aborted) {
            break
          }
        }
        if (this.ollamaOnlyFetchQueued) {
          this.ollamaOnlyFetchQueued = false
          const ollamaSignal = await this.runWithFetchAbortSignal((fetchSignal) =>
            this.runFetchOllamaOnlyCycle(fetchSignal)
          )
          if (ollamaSignal.aborted) {
            break
          }
        }
      }
    } finally {
      this.isFetching = false
      this.resolveFetchIdleWaiters()
    }
  }

  protected async fetchCodexOnly(options?: { force?: boolean }): Promise<void> {
    if (this.isFetching) {
      if (options?.force) {
        this.codexOnlyFetchQueued = true
        return this.waitForFetchIdle()
      }
      return
    }
    this.isFetching = true

    try {
      let shouldContinue = true
      while (shouldContinue) {
        const signal = await this.runWithFetchAbortSignal((fetchSignal) =>
          this.runFetchCodexOnlyCycle(fetchSignal)
        )
        shouldContinue = false
        if (signal.aborted) {
          break
        }
        if (this.fullFetchQueued) {
          this.fullFetchQueued = false
          const fullSignal = await this.runWithFetchAbortSignal((fetchSignal) =>
            this.runFetchAllCycle(fetchSignal, { force: true })
          )
          if (fullSignal.aborted) {
            break
          }
          continue
        }
        if (this.codexOnlyFetchQueued) {
          this.codexOnlyFetchQueued = false
          shouldContinue = true
        }
        if (this.claudeOnlyFetchQueued) {
          this.claudeOnlyFetchQueued = false
          const claudeSignal = await this.runWithFetchAbortSignal((fetchSignal) =>
            this.runFetchClaudeOnlyCycle(fetchSignal, { force: true })
          )
          if (claudeSignal.aborted) {
            break
          }
        }
        if (this.grokOnlyFetchQueued) {
          this.grokOnlyFetchQueued = false
          const grokSignal = await this.runWithFetchAbortSignal((fetchSignal) =>
            this.runFetchGrokOnlyCycle(fetchSignal)
          )
          if (grokSignal.aborted) {
            break
          }
        }
        if (this.ollamaOnlyFetchQueued) {
          this.ollamaOnlyFetchQueued = false
          const ollamaSignal = await this.runWithFetchAbortSignal((fetchSignal) =>
            this.runFetchOllamaOnlyCycle(fetchSignal)
          )
          if (ollamaSignal.aborted) {
            break
          }
        }
      }
    } finally {
      this.isFetching = false
      this.resolveFetchIdleWaiters()
    }
  }

  protected async fetchClaudeOnly(options?: { force?: boolean }): Promise<void> {
    if (this.isFetching) {
      if (options?.force) {
        this.claudeOnlyFetchQueued = true
        return this.waitForFetchIdle()
      }
      return
    }
    this.isFetching = true

    try {
      let shouldContinue = true
      // Only user-forced refreshes bypass Retry-After; queued reruns inherit that force.
      let cycleForce = options?.force ?? false
      while (shouldContinue) {
        const signal = await this.runWithFetchAbortSignal((fetchSignal) =>
          this.runFetchClaudeOnlyCycle(fetchSignal, { force: cycleForce })
        )
        shouldContinue = false
        cycleForce = true
        if (signal.aborted) {
          break
        }
        if (this.fullFetchQueued) {
          this.fullFetchQueued = false
          const fullSignal = await this.runWithFetchAbortSignal((fetchSignal) =>
            this.runFetchAllCycle(fetchSignal, { force: true })
          )
          if (fullSignal.aborted) {
            break
          }
          continue
        }
        if (this.claudeOnlyFetchQueued) {
          this.claudeOnlyFetchQueued = false
          shouldContinue = true
        }
        if (this.codexOnlyFetchQueued) {
          this.codexOnlyFetchQueued = false
          const codexSignal = await this.runWithFetchAbortSignal((fetchSignal) =>
            this.runFetchCodexOnlyCycle(fetchSignal)
          )
          if (codexSignal.aborted) {
            break
          }
        }
        if (this.grokOnlyFetchQueued) {
          this.grokOnlyFetchQueued = false
          const grokSignal = await this.runWithFetchAbortSignal((fetchSignal) =>
            this.runFetchGrokOnlyCycle(fetchSignal)
          )
          if (grokSignal.aborted) {
            break
          }
        }
        if (this.ollamaOnlyFetchQueued) {
          this.ollamaOnlyFetchQueued = false
          const ollamaSignal = await this.runWithFetchAbortSignal((fetchSignal) =>
            this.runFetchOllamaOnlyCycle(fetchSignal)
          )
          if (ollamaSignal.aborted) {
            break
          }
        }
      }
    } finally {
      this.isFetching = false
      this.resolveFetchIdleWaiters()
    }
  }

  protected async fetchGrokOnly(options?: { force?: boolean }): Promise<void> {
    if (this.isFetching) {
      if (options?.force) {
        this.grokOnlyFetchQueued = true
        return this.waitForFetchIdle()
      }
      return
    }
    this.isFetching = true
    try {
      await this.runSingleProviderDrain(
        (fetchSignal) => this.runFetchGrokOnlyCycle.bind(this)(fetchSignal),
        () => this.grokOnlyFetchQueued,
        () => {
          this.grokOnlyFetchQueued = false
        }
      )
    } finally {
      this.isFetching = false
      this.resolveFetchIdleWaiters()
    }
  }

  protected async ollamaOnlyFetch(options?: { force?: boolean }): Promise<void> {
    if (this.isFetching) {
      if (options?.force) {
        this.ollamaOnlyFetchQueued = true
        return this.waitForFetchIdle()
      }
      return
    }
    this.isFetching = true
    try {
      await this.runSingleProviderDrain(
        (fetchSignal) => this.runFetchOllamaOnlyCycle.bind(this)(fetchSignal),
        () => this.ollamaOnlyFetchQueued,
        () => {
          this.ollamaOnlyFetchQueued = false
        }
      )
    } finally {
      this.isFetching = false
      this.resolveFetchIdleWaiters()
    }
  }
}
