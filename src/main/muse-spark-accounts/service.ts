import type { Store } from '../persistence'
import type {
  MuseSparkManagedAccount,
  MuseSparkManagedAccountRuntimeSelection,
  MuseSparkManagedAccountSummary,
  MuseSparkRateLimitAccountsState
} from '../../shared/types'

export type MuseSparkAccountSelectionTarget = {
  runtime: 'host' | 'wsl'
  wslDistro?: string | null
}

/**
 * Scaffolded MuseSpark account provider. Every layer (types, RPC, IPC, preload,
 * renderer, mobile) is wired, but discovery is a no-op until MuseSpark ships a
 * real credential source — see `discoverAccounts`. Until then `listAccounts`
 * returns whatever is persisted (empty by default) and select/remove operate on
 * Orca's own active pointer, exactly like the read-only Cursor provider.
 */
export class MuseSparkAccountService {
  private mutationQueue: Promise<unknown> = Promise.resolve()

  constructor(private readonly store: Store) {}

  listAccounts(): MuseSparkRateLimitAccountsState {
    this.reconcileDiscoveredAccounts()
    this.normalizeActiveSelection()
    return this.getSnapshot()
  }

  async addAccount(): Promise<MuseSparkRateLimitAccountsState> {
    return this.serializeMutation(async () => this.listAccounts())
  }

  async removeAccount(accountId: string): Promise<MuseSparkRateLimitAccountsState> {
    return this.serializeMutation(async () => this.doRemoveAccount(accountId))
  }

  async selectAccount(accountId: string | null): Promise<MuseSparkRateLimitAccountsState> {
    return this.serializeMutation(async () => this.doSelectAccount(accountId))
  }

  async selectAccountForTarget(
    accountId: string | null,
    _target?: MuseSparkAccountSelectionTarget
  ): Promise<MuseSparkRateLimitAccountsState> {
    return this.serializeMutation(async () => this.doSelectAccount(accountId))
  }

  private serializeMutation<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(fn, fn)
    this.mutationQueue = next.catch(() => {})
    return next
  }

  /**
   * TODO(muse-spark): read MuseSpark's real credential source once it exists and
   * upsert discovered identities into `museSparkManagedAccounts`, mirroring
   * CursorAccountService.reconcileDiscoveredAccount. No source today, so no-op.
   */
  private reconcileDiscoveredAccounts(): void {}

  private doRemoveAccount(accountId: string): MuseSparkRateLimitAccountsState {
    const settings = this.store.getSettings()
    const nextAccounts = settings.museSparkManagedAccounts.filter((entry) => entry.id !== accountId)
    const nextActiveId =
      settings.activeMuseSparkManagedAccountId === accountId
        ? null
        : settings.activeMuseSparkManagedAccountId
    this.store.updateSettings({
      museSparkManagedAccounts: nextAccounts,
      activeMuseSparkManagedAccountId: nextActiveId,
      activeMuseSparkManagedAccountIdsByRuntime: { host: nextActiveId, wsl: {} }
    })
    this.normalizeActiveSelection()
    return this.getSnapshot()
  }

  private doSelectAccount(accountId: string | null): MuseSparkRateLimitAccountsState {
    if (accountId !== null) {
      this.requireAccount(accountId)
    }
    this.store.updateSettings({
      activeMuseSparkManagedAccountId: accountId,
      activeMuseSparkManagedAccountIdsByRuntime: { host: accountId, wsl: {} }
    })
    return this.getSnapshot()
  }

  private getSnapshot(): MuseSparkRateLimitAccountsState {
    const settings = this.store.getSettings()
    const selection = this.normalizeSelection(settings.activeMuseSparkManagedAccountId)
    return {
      accounts: settings.museSparkManagedAccounts
        .map((account) => this.toSummary(account))
        .sort((a, b) => b.updatedAt - a.updatedAt),
      activeAccountId: selection.host,
      activeAccountIdsByRuntime: selection
    }
  }

  private toSummary(account: MuseSparkManagedAccount): MuseSparkManagedAccountSummary {
    return {
      id: account.id,
      email: account.email,
      managedRuntime: account.managedRuntime ?? 'host',
      wslDistro: account.wslDistro ?? null,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
      lastAuthenticatedAt: account.lastAuthenticatedAt
    }
  }

  private normalizeSelection(activeId: string | null): MuseSparkManagedAccountRuntimeSelection {
    return { host: activeId, wsl: {} }
  }

  private requireAccount(accountId: string): MuseSparkManagedAccount {
    const account = this.store
      .getSettings()
      .museSparkManagedAccounts.find((entry) => entry.id === accountId)
    if (!account) {
      throw new Error('That MuseSpark account no longer exists.')
    }
    return account
  }

  private normalizeActiveSelection(): void {
    const settings = this.store.getSettings()
    const activeId = settings.activeMuseSparkManagedAccountId
    const stillExists = activeId
      ? settings.museSparkManagedAccounts.some((entry) => entry.id === activeId)
      : false
    const nextActiveId = stillExists ? activeId : null
    if (
      nextActiveId !== settings.activeMuseSparkManagedAccountId ||
      settings.activeMuseSparkManagedAccountIdsByRuntime?.host !== nextActiveId
    ) {
      this.store.updateSettings({
        activeMuseSparkManagedAccountId: nextActiveId,
        activeMuseSparkManagedAccountIdsByRuntime: { host: nextActiveId, wsl: {} }
      })
    }
  }
}
