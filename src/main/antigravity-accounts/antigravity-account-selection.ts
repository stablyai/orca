import type {
  AntigravityManagedAccountSummary,
  AntigravityRateLimitAccountsState
} from '../../shared/antigravity-managed-account-types'
import type { Store } from '../persistence'
import {
  normalizeAntigravityRuntimeSelection,
  removeAntigravityAccountIdFromSelection,
  setSelectedAntigravityAccountIdForTarget,
  type AntigravityAccountSelectionTarget
} from './runtime-selection'

export class AntigravityAccountSelection {
  constructor(
    private readonly store: Store,
    private readonly removeManagedAuth: (accountId: string, path: string) => Promise<void>
  ) {}

  list(): AntigravityRateLimitAccountsState {
    const settings = this.store.getSettings()
    const accounts: AntigravityManagedAccountSummary[] = settings.antigravityManagedAccounts.map(
      (account) => ({
        id: account.id,
        label: account.label,
        managedAuthRuntime: account.managedAuthRuntime,
        wslDistro: account.wslDistro,
        authMethod: account.authMethod,
        email: account.email,
        createdAt: account.createdAt,
        updatedAt: account.updatedAt,
        lastAuthenticatedAt: account.lastAuthenticatedAt
      })
    )
    return {
      accounts,
      activeAccountId: settings.activeAntigravityManagedAccountId,
      activeAccountIdsByRuntime: settings.activeAntigravityManagedAccountIdsByRuntime
    }
  }

  async remove(accountId: string): Promise<AntigravityRateLimitAccountsState> {
    const settings = this.store.getSettings()
    const account = settings.antigravityManagedAccounts.find((entry) => entry.id === accountId)
    if (!account) {
      throw new Error(`Antigravity account not found: ${accountId}`)
    }
    const nextAccounts = settings.antigravityManagedAccounts.filter((entry) => entry.id !== accountId)
    const nextSelection = removeAntigravityAccountIdFromSelection(
      normalizeAntigravityRuntimeSelection(settings),
      accountId
    )
    const nextActiveId =
      settings.activeAntigravityManagedAccountId === accountId ? null : nextSelection.host
    this.store.updateSettings({
      antigravityManagedAccounts: nextAccounts,
      activeAntigravityManagedAccountId: nextActiveId,
      activeAntigravityManagedAccountIdsByRuntime: nextSelection
    })
    await this.removeManagedAuth(accountId, account.managedAuthPath)
    return this.snapshot()
  }

  async select(
    accountId: string | null,
    target?: AntigravityAccountSelectionTarget
  ): Promise<AntigravityRateLimitAccountsState> {
    const settings = this.store.getSettings()
    const selection = normalizeAntigravityRuntimeSelection(settings)
    const nextSelection = setSelectedAntigravityAccountIdForTarget(selection, accountId, target)
    const nextActiveId = nextSelection.host
    this.store.updateSettings({
      activeAntigravityManagedAccountId: nextActiveId,
      activeAntigravityManagedAccountIdsByRuntime: nextSelection
    })
    return this.snapshot()
  }

  private snapshot(): AntigravityRateLimitAccountsState {
    const settings = this.store.getSettings()
    const accounts: AntigravityManagedAccountSummary[] = settings.antigravityManagedAccounts.map(
      (account) => ({
        id: account.id,
        label: account.label,
        managedAuthRuntime: account.managedAuthRuntime,
        wslDistro: account.wslDistro,
        authMethod: account.authMethod,
        email: account.email,
        createdAt: account.createdAt,
        updatedAt: account.updatedAt,
        lastAuthenticatedAt: account.lastAuthenticatedAt
      })
    )
    return {
      accounts,
      activeAccountId: settings.activeAntigravityManagedAccountId,
      activeAccountIdsByRuntime: settings.activeAntigravityManagedAccountIdsByRuntime
    }
  }
}
