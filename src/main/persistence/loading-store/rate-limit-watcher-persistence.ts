import { MAX_RATE_LIMIT_WATCHER_TABS } from '../../../shared/rate-limit-watcher-types'
import type { StoreRuntimeState } from './store-runtime-state'
import type { WriteSchedulingOperations } from './write-scheduling'
import { scheduleSave } from './write-scheduling'

type RateLimitWatcherPersistenceRuntime = Pick<StoreRuntimeState, 'state'>

const rateLimitWatcherPersistenceContext = Symbol('RateLimitWatcherPersistence')
type RateLimitWatcherPersistenceContext = {
  runtime: RateLimitWatcherPersistenceRuntime
  scheduling: WriteSchedulingOperations
}

export class RateLimitWatcherPersistence {
  readonly [rateLimitWatcherPersistenceContext]: RateLimitWatcherPersistenceContext

  constructor(runtime: RateLimitWatcherPersistenceRuntime, scheduling: WriteSchedulingOperations) {
    this[rateLimitWatcherPersistenceContext] = { runtime, scheduling }
  }

  listRateLimitWatcherTabs(): string[] {
    return this[rateLimitWatcherPersistenceContext].runtime.state.rateLimitWatcherTabs ?? []
  }

  isRateLimitWatcherEnabled(tabId: string): boolean {
    return this.listRateLimitWatcherTabs().includes(tabId)
  }

  setRateLimitWatcherEnabled(tabId: string, enabled: boolean): void {
    const { runtime, scheduling } = this[rateLimitWatcherPersistenceContext]
    const existing = this.listRateLimitWatcherTabs()
    if (existing.includes(tabId) === enabled) {
      return
    }
    const others = existing.filter((entry) => entry !== tabId)
    runtime.state.rateLimitWatcherTabs = enabled
      ? [...others, tabId].slice(-MAX_RATE_LIMIT_WATCHER_TABS)
      : others
    scheduleSave(scheduling)
  }
}

export function installRateLimitWatcherPersistenceContext(
  target: RateLimitWatcherPersistence,
  source: RateLimitWatcherPersistence
): void {
  Object.defineProperty(target, rateLimitWatcherPersistenceContext, {
    value: source[rateLimitWatcherPersistenceContext]
  })
}
