import type { AntigravityRateLimitAccountsState } from '../../shared/antigravity-managed-account-types'
import type { Store } from '../persistence'
import { AntigravityAccountRegistration } from './antigravity-account-registration'
import { AntigravityAccountSelection } from './antigravity-account-selection'
import {
  AntigravityManagedAuthStorage,
  type AntigravityManagedAuthLocation
} from './antigravity-managed-auth-storage'

export type AntigravityAccountAddTarget = {
  runtime?: 'host' | 'wsl'
  wslDistro?: string | null
}

export class AntigravityAccountService {
  private readonly storage = new AntigravityManagedAuthStorage()
  private readonly selection: AntigravityAccountSelection
  private readonly registration: AntigravityAccountRegistration

  constructor(store: Store) {
    this.selection = new AntigravityAccountSelection(store, (_accountId, path) =>
      this.storage.remove(path).then(() => undefined)
    )
    this.registration = new AntigravityAccountRegistration({
      store,
      selection: this.selection,
      storage: this.storage,
      login: (location) => this.runAntigravityLoginAndCapture(location)
    })
  }

  listAccounts(): AntigravityRateLimitAccountsState {
    return this.selection.list()
  }

  async addAccount(target?: AntigravityAccountAddTarget): Promise<AntigravityRateLimitAccountsState> {
    return this.registration.add(target)
  }

  async reauthenticateAccount(accountId: string): Promise<AntigravityRateLimitAccountsState> {
    return this.registration.reauthenticate(accountId)
  }

  async removeAccount(accountId: string): Promise<AntigravityRateLimitAccountsState> {
    return this.selection.remove(accountId)
  }

  async selectAccount(
    accountId: string | null,
    target?: { runtime?: 'host' | 'wsl'; wslDistro?: string | null }
  ): Promise<AntigravityRateLimitAccountsState> {
    return this.selection.select(accountId, target)
  }

  private async runAntigravityLoginAndCapture(
    _location: AntigravityManagedAuthLocation
  ): Promise<{ credentialsJson: string; email: string | null }> {
    // TODO: Implement actual antigravity CLI login flow
    // For now, return a placeholder that can be replaced with real implementation
    return {
      credentialsJson: JSON.stringify({}),
      email: null
    }
  }
}
