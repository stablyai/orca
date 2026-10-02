import { randomUUID } from 'node:crypto'
import type {
  AntigravityManagedAccount,
  AntigravityRateLimitAccountsState
} from '../../shared/antigravity-managed-account-types'
import type { Store } from '../persistence'
import type { AntigravityAccountSelection } from './antigravity-account-selection'
import type { AntigravityManagedAuthStorage, AntigravityManagedAuthLocation } from './antigravity-managed-auth-storage'

type AntigravityAccountRegistrationDependencies = {
  store: Store
  selection: AntigravityAccountSelection
  storage: AntigravityManagedAuthStorage
  login: (location: AntigravityManagedAuthLocation) => Promise<{ credentialsJson: string; email: string | null }>
}

export class AntigravityAccountRegistration {
  constructor(private readonly dependencies: AntigravityAccountRegistrationDependencies) {}

  async add(target?: { runtime?: 'host' | 'wsl'; wslDistro?: string | null }): Promise<AntigravityRateLimitAccountsState> {
    const accountId = randomUUID()
    const location = await this.dependencies.storage.create(accountId, target)
    const previousSettings = this.dependencies.store.getSettings()
    try {
      const captured = await this.dependencies.login(location)
      return await this.persist(accountId, location, previousSettings, captured)
    } catch (error) {
      await this.dependencies.storage.remove(location.managedAuthPath)
      this.dependencies.store.updateSettings(previousSettings)
      throw error
    }
  }

  async reauthenticate(accountId: string): Promise<AntigravityRateLimitAccountsState> {
    const settings = this.dependencies.store.getSettings()
    const account = settings.antigravityManagedAccounts.find((entry) => entry.id === accountId)
    if (!account) {
      throw new Error(`Antigravity account not found: ${accountId}`)
    }
    const trustedPath = await this.dependencies.storage.assertOwned(
      account.managedAuthPath,
      accountId
    )
    const captured = await this.dependencies.login({
      managedAuthPath: trustedPath,
      managedAuthRuntime: account.managedAuthRuntime ?? 'host',
      wslDistro: account.wslDistro ?? null
    })
    await this.dependencies.storage.writeAuth(accountId, trustedPath, {
      credentialsJson: captured.credentialsJson
    })
    const nextAccounts = settings.antigravityManagedAccounts.map((entry) =>
      entry.id === accountId
        ? { ...entry, lastAuthenticatedAt: Date.now(), email: captured.email }
        : entry
    )
    this.dependencies.store.updateSettings({ antigravityManagedAccounts: nextAccounts })
    return this.dependencies.selection.list()
  }

  private async persist(
    accountId: string,
    location: AntigravityManagedAuthLocation,
    previousSettings: Store['getSettings'] extends () => infer S ? S : never,
    captured: { credentialsJson: string; email: string | null }
  ): Promise<AntigravityRateLimitAccountsState> {
    const account: AntigravityManagedAccount = {
      id: accountId,
      label: captured.email ?? `Antigravity ${accountId.slice(0, 8)}`,
      managedAuthPath: location.managedAuthPath,
      managedAuthRuntime: location.managedAuthRuntime,
      wslDistro: location.wslDistro ?? null,
      authMethod: 'api-key',
      email: captured.email,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastAuthenticatedAt: Date.now()
    }
    await this.dependencies.storage.writeAuth(accountId, location.managedAuthPath, {
      credentialsJson: captured.credentialsJson
    })
    this.dependencies.store.updateSettings({
      antigravityManagedAccounts: [
        ...previousSettings.antigravityManagedAccounts,
        account
      ]
    })
    return this.dependencies.selection.list()
  }
}
