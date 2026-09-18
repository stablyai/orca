import { RateLimitServiceProviderCycles } from './service-provider-cycles'

type FetchLane = 'full' | 'codex' | 'claude' | 'grok' | 'devin'

type QueuedFlag =
  | 'fullFetchQueued'
  | 'codexOnlyFetchQueued'
  | 'claudeOnlyFetchQueued'
  | 'grokOnlyFetchQueued'
  | 'devinOnlyFetchQueued'

const LANE_QUEUED_FLAG: Record<FetchLane, QueuedFlag> = {
  full: 'fullFetchQueued',
  codex: 'codexOnlyFetchQueued',
  claude: 'claudeOnlyFetchQueued',
  grok: 'grokOnlyFetchQueued',
  devin: 'devinOnlyFetchQueued'
}

// Why: a queued lane drains in this fixed order after the owning lane reruns, so
// every entry point settles waiters identically regardless of which lane it started on.
const SIBLING_LANE_ORDER: readonly Exclude<FetchLane, 'full'>[] = [
  'codex',
  'claude',
  'grok',
  'devin'
]

export abstract class RateLimitServiceFetchQueue extends RateLimitServiceProviderCycles {
  protected fetchAll(options?: { force?: boolean }): Promise<void> {
    return this.runFetchLane('full', options)
  }

  protected fetchCodexOnly(options?: { force?: boolean }): Promise<void> {
    return this.runFetchLane('codex', options)
  }

  protected fetchClaudeOnly(options?: { force?: boolean }): Promise<void> {
    return this.runFetchLane('claude', options)
  }

  protected fetchGrokOnly(options?: { force?: boolean }): Promise<void> {
    return this.runFetchLane('grok', options)
  }

  protected fetchDevinOnly(options?: { force?: boolean }): Promise<void> {
    return this.runFetchLane('devin', options)
  }

  private runLaneCycle(lane: FetchLane, force: boolean): Promise<AbortSignal> {
    return this.runWithFetchAbortSignal((signal) => {
      switch (lane) {
        case 'full':
          return this.runFetchAllCycle(signal, { force })
        case 'codex':
          return this.runFetchCodexOnlyCycle(signal)
        case 'claude':
          return this.runFetchClaudeOnlyCycle(signal, { force })
        case 'grok':
          return this.runFetchGrokOnlyCycle(signal)
        case 'devin':
          return this.runFetchDevinOnlyCycle(signal)
      }
    })
  }

  /**
   * Runs `lane` once, then drains every lane queued while it ran: a queued full
   * fetch restarts the loop, a re-queued own lane reruns it, and other lanes run
   * once each. Concurrent callers queue behind the in-flight run and are settled
   * by `resolveFetchIdleWaiters` only once every queued flag is clear.
   */
  private async runFetchLane(lane: FetchLane, options?: { force?: boolean }): Promise<void> {
    const ownFlag = LANE_QUEUED_FLAG[lane]
    if (this.isFetching) {
      if (options?.force) {
        this[ownFlag] = true
        return this.waitForFetchIdle()
      }
      return
    }
    this.isFetching = true

    try {
      let shouldContinue = true
      // Why: only user-directed (force) fetches may bypass a provider's Retry-After gate; queued reruns inherit force because only forced calls queue them.
      let cycleForce = options?.force ?? false
      while (shouldContinue) {
        const signal = await this.runLaneCycle(lane, cycleForce)
        shouldContinue = false
        cycleForce = true
        if (signal.aborted) {
          break
        }
        if (this.fullFetchQueued) {
          this.fullFetchQueued = false
          if (lane === 'full') {
            shouldContinue = true
            continue
          }
          const fullSignal = await this.runLaneCycle('full', true)
          if (fullSignal.aborted) {
            break
          }
          continue
        }
        if (lane !== 'full' && this[ownFlag]) {
          this[ownFlag] = false
          shouldContinue = true
        }
        let aborted = false
        for (const sibling of SIBLING_LANE_ORDER) {
          if (sibling === lane) {
            continue
          }
          const siblingFlag = LANE_QUEUED_FLAG[sibling]
          if (!this[siblingFlag]) {
            continue
          }
          this[siblingFlag] = false
          const siblingSignal = await this.runLaneCycle(sibling, true)
          if (siblingSignal.aborted) {
            aborted = true
            break
          }
        }
        if (aborted) {
          break
        }
      }
    } finally {
      this.isFetching = false
      this.resolveFetchIdleWaiters()
    }
  }
}
