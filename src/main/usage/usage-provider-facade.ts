import type { ClaudeUsageStore } from '../claude-usage/store'
import type { CodexUsageStore } from '../codex-usage/store'
import type { OpenCodeUsageStore } from '../opencode-usage/store'
import type { MuseUsageStore } from '../muse-usage/store'
import type { UsageHistoryProvider } from '../../shared/usage-history-types'
import type { UsageSnapshotQuery } from '../../shared/usage-history-rpc'

export type UsageProviderStores = {
  claudeUsage: ClaudeUsageStore
  codexUsage: CodexUsageStore
  openCodeUsage: OpenCodeUsageStore
  museUsage: MuseUsageStore
}

export class UsageProviderFacade {
  private stores: UsageProviderStores | null = null

  setStores(stores: UsageProviderStores): void {
    this.stores = stores
  }

  async getSnapshot(provider: UsageHistoryProvider, query: UsageSnapshotQuery) {
    const store = this.providerStore(provider)
    await store.whenLoaded()
    return query.includeHistory === true
      ? store.getSnapshot(query.scope, query.range, query.limit, true)
      : store.getSnapshot(query.scope, query.range, query.limit)
  }

  async refresh(provider: UsageHistoryProvider, force = false) {
    return this.providerStore(provider).refresh(force)
  }

  async setEnabled(provider: UsageHistoryProvider, enabled: boolean) {
    return this.providerStore(provider).setEnabled(enabled)
  }

  private providerStore(provider: UsageHistoryProvider) {
    if (!this.stores) {
      throw new Error('Historical usage stores are not configured on this runtime')
    }
    switch (provider) {
      case 'claude':
        return this.stores.claudeUsage
      case 'codex':
        return this.stores.codexUsage
      case 'opencode':
        return this.stores.openCodeUsage
      case 'muse':
        return this.stores.museUsage
    }
  }
}
