import type { RateLimitWatcherSnapshot } from '../../shared/rate-limit-watcher-types'

export type RateLimitWatcherApi = {
  /** Armed terminal tab ids. Hydrated once per renderer load. */
  get: () => Promise<RateLimitWatcherSnapshot>
  /** Arm or disarm one terminal; resolves to the resulting armed set. */
  set: (tabId: string, enabled: boolean) => Promise<RateLimitWatcherSnapshot>
}
