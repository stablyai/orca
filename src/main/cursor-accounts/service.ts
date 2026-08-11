import { app } from 'electron'
import type { Store } from '../persistence'
import type {
  CursorManagedAccount,
  CursorManagedAccountRuntimeSelection,
  CursorManagedAccountSummary,
  CursorRateLimitAccountsState
} from '../../shared/types'
import {
  cursorAccountId,
  discoverCursorAccount,
  resolveCursorStateDbPath
} from './cursor-auth-discovery'

export type CursorAccountSelectionTarget = { runtime: 'host' | 'wsl'; wslDistro?: string | null }

/**
 * Read-only Cursor account provider. Unlike Claude/Codex, Orca never writes
 * Cursor's config — sign-in happens inside Cursor itself. `listAccounts` mirrors
 * the identity signed into Cursor's local `state.vscdb` into Orca's persisted
 * list; select/remove only move Orca's own active pointer.
 *
 * Host-only for now: remote (SSH/WSL) discovery needs the host filesystem and is
 * a follow-up — the selection model already carries the runtime shape so adding
 * it later does not change the wire contract.
 */
export class CursorAccountService {
  private mutationQueue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly store: Store,
    private readonly resolveAppDataDir: () => string = () => app.getPath('appData')
  ) {}

  listAccounts(): CursorRateLimitAccountsState {
    this.reconcileDiscoveredAccount()
    this.normalizeActiveSelection()
    return this.getSnapshot()
  }

  async addAccount(): Promise<CursorRateLimitAccountsState> {
    // "Add" for a read-only provider is a rescan of Cursor's signed-in identity.
    return this.serializeMutation(async () => this.listAccounts())
  }

  async removeAccount(accountId: string): Promise<CursorRateLimitAccountsState> {
    return this.serializeMutation(async () => this.doRemoveAccount(accountId))
  }

  async selectAccount(accountId: string | null): Promise<CursorRateLimitAccountsState> {
    return this.serializeMutation(async () => this.doSelectAccount(accountId))
  }

  async selectAccountForTarget(
    accountId: string | null,
    _target?: CursorAccountSelectionTarget
  ): Promise<CursorRateLimitAccountsState> {
    // Host-only today; the target is accepted for wire parity with Claude/Codex.
    return this.serializeMutation(async () => this.doSelectAccount(accountId))
  }

  private serializeMutation<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(fn, fn)
    this.mutationQueue = next.catch(() => {})
    return next
  }

  private doRemoveAccount(accountId: string): CursorRateLimitAccountsState {
    const settings = this.store.getSettings()
    const nextAccounts = settings.cursorManagedAccounts.filter((entry) => entry.id !== accountId)
    const nextActiveId =
      settings.activeCursorManagedAccountId === accountId
        ? null
        : settings.activeCursorManagedAccountId
    this.store.updateSettings({
      cursorManagedAccounts: nextAccounts,
      activeCursorManagedAccountId: nextActiveId,
      activeCursorManagedAccountIdsByRuntime: { host: nextActiveId, wsl: {} }
    })
    this.normalizeActiveSelection()
    return this.getSnapshot()
  }

  private doSelectAccount(accountId: string | null): CursorRateLimitAccountsState {
    if (accountId !== null) {
      this.requireAccount(accountId)
    }
    this.store.updateSettings({
      activeCursorManagedAccountId: accountId,
      activeCursorManagedAccountIdsByRuntime: { host: accountId, wsl: {} }
    })
    return this.getSnapshot()
  }

  /** Upsert the currently signed-in Cursor identity into the persisted list. */
  private reconcileDiscoveredAccount(): void {
    let discovered: ReturnType<typeof discoverCursorAccount> = null
    try {
      discovered = discoverCursorAccount(resolveCursorStateDbPath(this.resolveAppDataDir()))
    } catch {
      discovered = null
    }
    if (!discovered) {
      return
    }
    const settings = this.store.getSettings()
    const id = cursorAccountId(discovered.authId, discovered.email)
    const now = Date.now()
    const existing = settings.cursorManagedAccounts.find((entry) => entry.id === id)
    const merged: CursorManagedAccount = {
      id,
      email: discovered.email,
      authId: discovered.authId,
      membershipType: discovered.membershipType,
      signUpType: discovered.signUpType,
      configDbPath: discovered.configDbPath,
      managedRuntime: 'host',
      wslDistro: null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastAuthenticatedAt: now
    }
    const nextAccounts = existing
      ? settings.cursorManagedAccounts.map((entry) => (entry.id === id ? merged : entry))
      : [...settings.cursorManagedAccounts, merged]
    // Reflecting the signed-in identity: make it active when nothing is selected.
    const nextActiveId = settings.activeCursorManagedAccountId ?? id
    this.store.updateSettings({
      cursorManagedAccounts: nextAccounts,
      activeCursorManagedAccountId: nextActiveId,
      activeCursorManagedAccountIdsByRuntime: { host: nextActiveId, wsl: {} }
    })
  }

  private getSnapshot(): CursorRateLimitAccountsState {
    const settings = this.store.getSettings()
    const selection = this.normalizeSelection(settings.activeCursorManagedAccountId)
    return {
      accounts: settings.cursorManagedAccounts
        .map((account) => this.toSummary(account))
        .sort((a, b) => b.updatedAt - a.updatedAt),
      activeAccountId: selection.host,
      activeAccountIdsByRuntime: selection
    }
  }

  private toSummary(account: CursorManagedAccount): CursorManagedAccountSummary {
    return {
      id: account.id,
      email: account.email,
      authId: account.authId ?? null,
      membershipType: account.membershipType ?? null,
      signUpType: account.signUpType ?? null,
      managedRuntime: account.managedRuntime ?? 'host',
      wslDistro: account.wslDistro ?? null,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
      lastAuthenticatedAt: account.lastAuthenticatedAt
    }
  }

  private normalizeSelection(activeId: string | null): CursorManagedAccountRuntimeSelection {
    return { host: activeId, wsl: {} }
  }

  private requireAccount(accountId: string): CursorManagedAccount {
    const account = this.store
      .getSettings()
      .cursorManagedAccounts.find((entry) => entry.id === accountId)
    if (!account) {
      throw new Error('That Cursor account no longer exists.')
    }
    return account
  }

  private normalizeActiveSelection(): void {
    const settings = this.store.getSettings()
    const activeId = settings.activeCursorManagedAccountId
    const stillExists = activeId
      ? settings.cursorManagedAccounts.some((entry) => entry.id === activeId)
      : false
    const nextActiveId = stillExists ? activeId : null
    if (
      nextActiveId !== settings.activeCursorManagedAccountId ||
      settings.activeCursorManagedAccountIdsByRuntime?.host !== nextActiveId
    ) {
      this.store.updateSettings({
        activeCursorManagedAccountId: nextActiveId,
        activeCursorManagedAccountIdsByRuntime: { host: nextActiveId, wsl: {} }
      })
    }
  }
}
