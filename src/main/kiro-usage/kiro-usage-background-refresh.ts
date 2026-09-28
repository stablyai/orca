import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import type { KiroUsageSnapshot } from '../../shared/kiro-usage-types'
import { reconcileKiroProvider } from '../../shared/kiro-usage-reconcile'
import { MIN_REFETCH_MS } from '../rate-limits/service/service-types'
import { fetchKiroUsage } from './kiro-usage-fetcher'
import { kiroUsageToProviderRateLimits } from './kiro-usage-to-rate-limits'

export type KiroUsageStore = {
  read: () => ProviderRateLimits | null
  write: (limits: ProviderRateLimits) => void
}

export type KiroUsageBackgroundRefreshOptions = {
  store: KiroUsageStore
  fetch?: () => Promise<KiroUsageSnapshot>
  now?: () => number
  ttlMs?: number
}

/**
 * Owns the `kiro-cli /usage` read on behalf of every surface.
 *
 * Why it is background-only: the read costs ~10s and retries up to three times,
 * while the phone's RPC deadline is 30s — awaiting it inside `accounts.list`
 * spent the client's whole budget on one provider and failed the refresh. The
 * result instead reaches desktop and phone the same way every polled provider's
 * does, by landing in the rate-limit state and being pushed to subscribers.
 */
export class KiroUsageBackgroundRefresh {
  private inFlight: Promise<void> | null = null
  /** Null until the first read settles — "never read" is always stale. */
  private lastSettledAt: number | null = null

  constructor(private readonly options: KiroUsageBackgroundRefreshOptions) {}

  /**
   * Start a read unless one is already running or the last result is still
   * fresh. Callers on a request path discard the promise; it is returned so
   * tests and explicit flows can await the settle.
   */
  requestRefresh(options: { force?: boolean } = {}): Promise<void> {
    if (this.inFlight) {
      return this.inFlight
    }
    const ttlMs = this.options.ttlMs ?? MIN_REFETCH_MS
    if (!options.force && this.lastSettledAt !== null && this.now() - this.lastSettledAt < ttlMs) {
      return Promise.resolve()
    }
    const run = this.read().finally(() => {
      this.lastSettledAt = this.now()
      this.inFlight = null
    })
    this.inFlight = run
    return run
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  private async read(): Promise<void> {
    const { store } = this.options
    const previous = store.read()
    // Why only with a previous value: a non-null snapshot is what makes the Kiro
    // segment visible at all, so marking an unread provider 'fetching' would
    // surface an empty meter on machines with no kiro-cli.
    if (previous) {
      store.write({ ...previous, status: 'fetching' })
    }
    try {
      const next = kiroUsageToProviderRateLimits(await (this.options.fetch ?? fetchKiroUsage)())
      // Why: a transient failure keeps the last good monthly window instead of
      // blanking the meter (see reconcileKiroProvider).
      store.write(reconcileKiroProvider(previous, next))
    } catch {
      // A missing or unauthenticated CLI must not disturb the accounts refresh.
      if (previous) {
        store.write(previous)
      }
    }
  }
}
