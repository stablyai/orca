export type UsageAnalyticsProvider = 'claude' | 'codex' | 'opencode' | 'muse'
type UsageAnalyticsScope = 'orca' | 'all'
type UsageAnalyticsRange = '7d' | '30d' | '90d' | 'all'

type UsageAnalyticsStore = {
  whenLoaded: () => Promise<void>
  getScanState: () => unknown
  setEnabled: (enabled: boolean) => Promise<unknown>
  refresh: (force?: boolean) => Promise<unknown>
  getSnapshot: (scope: UsageAnalyticsScope, range: UsageAnalyticsRange, limit?: number) => unknown
}

export type RuntimeUsageAnalyticsStores = Record<UsageAnalyticsProvider, UsageAnalyticsStore>

/** Serves this host's token analytics to paired clients, mirroring the desktop usage IPC. */
export class RuntimeUsageAnalyticsController {
  private stores: RuntimeUsageAnalyticsStores | null = null

  setStores(stores: RuntimeUsageAnalyticsStores): void {
    this.stores = stores
  }

  async getScanState(provider: UsageAnalyticsProvider): Promise<unknown> {
    const store = this.requireStore(provider)
    // Why: persisted state can still be loading on the worker; the getter must not see defaults.
    await store.whenLoaded()
    return store.getScanState()
  }

  setEnabled(provider: UsageAnalyticsProvider, enabled: boolean): Promise<unknown> {
    return this.requireStore(provider).setEnabled(enabled)
  }

  refresh(provider: UsageAnalyticsProvider, force: boolean): Promise<unknown> {
    return this.requireStore(provider).refresh(force)
  }

  async getSnapshot(
    provider: UsageAnalyticsProvider,
    scope: UsageAnalyticsScope,
    range: UsageAnalyticsRange,
    limit?: number
  ): Promise<unknown> {
    const store = this.requireStore(provider)
    await store.whenLoaded()
    return store.getSnapshot(scope, range, limit)
  }

  private requireStore(provider: UsageAnalyticsProvider): UsageAnalyticsStore {
    if (!this.stores) {
      throw new Error('Usage analytics are not available on this host.')
    }
    return this.stores[provider]
  }
}
