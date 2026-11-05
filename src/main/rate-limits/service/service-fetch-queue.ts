import { RateLimitServiceProviderCycles } from './service-provider-cycles'

export abstract class RateLimitServiceFetchQueue extends RateLimitServiceProviderCycles {
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
      }
    } finally {
      this.isFetching = false
      this.resolveFetchIdleWaiters()
    }
  }

  protected async fetchCodexOnly(options?: {
    force?: boolean
    signal?: AbortSignal
  }): Promise<void> {
    if (options?.signal?.aborted) {
      return
    }
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
      // Queued reruns belong to other callers, so only the first cycle obeys this caller's signal.
      let externalSignal = options?.signal
      while (shouldContinue) {
        const signal = await this.runProviderCycleWithExternalSignal(
          'codex',
          (fetchSignal) => this.runFetchCodexOnlyCycle(fetchSignal),
          externalSignal
        )
        externalSignal = undefined
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
      }
    } finally {
      this.isFetching = false
      this.resolveFetchIdleWaiters()
    }
  }

  protected async fetchClaudeOnly(options?: {
    force?: boolean
    signal?: AbortSignal
  }): Promise<void> {
    if (options?.signal?.aborted) {
      return
    }
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
      let externalSignal = options?.signal
      while (shouldContinue) {
        const signal = await this.runProviderCycleWithExternalSignal(
          'claude',
          (fetchSignal) => this.runFetchClaudeOnlyCycle(fetchSignal, { force: cycleForce }),
          externalSignal
        )
        externalSignal = undefined
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
      let shouldContinue = true
      while (shouldContinue) {
        const signal = await this.runWithFetchAbortSignal((fetchSignal) =>
          this.runFetchGrokOnlyCycle(fetchSignal)
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
        if (this.grokOnlyFetchQueued) {
          this.grokOnlyFetchQueued = false
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
        if (this.claudeOnlyFetchQueued) {
          this.claudeOnlyFetchQueued = false
          const claudeSignal = await this.runWithFetchAbortSignal((fetchSignal) =>
            this.runFetchClaudeOnlyCycle(fetchSignal, { force: true })
          )
          if (claudeSignal.aborted) {
            break
          }
        }
      }
    } finally {
      this.isFetching = false
      this.resolveFetchIdleWaiters()
    }
  }

  private async runProviderCycleWithExternalSignal(
    provider: 'claude' | 'codex',
    run: (signal: AbortSignal) => Promise<void>,
    externalSignal: AbortSignal | undefined
  ): Promise<AbortSignal> {
    const before = this.state[provider]
    const generation = this.providerFetchGeneration(provider)
    const signal = await this.runWithFetchAbortSignal(run, externalSignal)
    const current = this.state[provider]
    // An externally aborted cycle skips its apply step; settle the loading chip it set.
    if (
      externalSignal?.aborted &&
      !signal.aborted &&
      current !== before &&
      current?.status === 'fetching' &&
      generation === this.providerFetchGeneration(provider)
    ) {
      this.updateState({
        ...this.state,
        [provider]: before?.status === 'fetching' ? null : before
      })
    }
    return signal
  }

  private providerFetchGeneration(provider: 'claude' | 'codex'): number {
    return provider === 'claude' ? this.claudeFetchGeneration : this.codexFetchGeneration
  }
}
