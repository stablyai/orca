import { RateLimitServiceState } from './service-state'

export abstract class RateLimitServiceFetchControl extends RateLimitServiceState {
  protected waitForFetchIdle(): Promise<void> {
    if (
      !this.isFetching &&
      !this.fullFetchQueued &&
      !this.codexOnlyFetchQueued &&
      !this.claudeOnlyFetchQueued &&
      !this.grokOnlyFetchQueued
    ) {
      return Promise.resolve()
    }
    // Why: explicit-refresh callers must await the queued follow-up cycle when a poll is in flight, else the UI stops spinning early.
    return new Promise((resolve) => {
      this.fetchIdleResolvers.push(resolve)
    })
  }

  protected resolveFetchIdleWaiters(): void {
    if (
      this.isFetching ||
      this.fullFetchQueued ||
      this.codexOnlyFetchQueued ||
      this.claudeOnlyFetchQueued ||
      this.grokOnlyFetchQueued
    ) {
      return
    }
    const resolvers = this.fetchIdleResolvers
    this.fetchIdleResolvers = []
    for (const resolve of resolvers) {
      resolve()
    }
  }

  protected beginFetchCycle(): AbortController {
    const controller = new AbortController()
    this.activeFetchAbortControllers.add(controller)
    return controller
  }

  protected finishFetchCycle(controller: AbortController): void {
    this.activeFetchAbortControllers.delete(controller)
  }

  protected async runWithFetchAbortSignal(
    fn: (signal: AbortSignal) => Promise<void>
  ): Promise<AbortSignal> {
    const controller = this.beginFetchCycle()
    try {
      await fn(controller.signal)
      return controller.signal
    } finally {
      this.finishFetchCycle(controller)
    }
  }

  protected abortActiveFetchCycle(): void {
    for (const controller of this.activeFetchAbortControllers) {
      controller.abort()
    }
    this.activeFetchAbortControllers.clear()
  }

  protected clearQueuedFetches(): void {
    this.fullFetchQueued = false
    this.codexOnlyFetchQueued = false
    this.claudeOnlyFetchQueued = false
    this.grokOnlyFetchQueued = false
  }

  protected resolveAndClearFetchIdleWaiters(): void {
    const resolvers = this.fetchIdleResolvers
    this.fetchIdleResolvers = []
    for (const resolve of resolvers) {
      resolve()
    }
  }
}
