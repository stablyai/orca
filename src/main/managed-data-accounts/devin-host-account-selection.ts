import { join } from 'node:path'
import type {
  ManagedDataAccountProvider,
  ManagedDataAccountsState,
  ManagedDataAccountSummary
} from '../../shared/managed-account-types'
import { DevinHostCredentialSync } from './devin-host-credential-sync'

type DevinHostAccountSelectionOptions = {
  root: string
  platform: NodeJS.Platform
  appDataRoot?: string
  accountDirectory: (accountId: string) => string
  assertOwned: (path: string) => void
}

export class DevinHostAccountSelection {
  private readonly credentialSync: DevinHostCredentialSync

  constructor(private readonly options: DevinHostAccountSelectionOptions) {
    this.credentialSync = new DevinHostCredentialSync(options.root, {
      appDataRoot: options.appDataRoot
    })
  }

  persistTransition(
    provider: ManagedDataAccountProvider,
    previous: ManagedDataAccountsState,
    next: ManagedDataAccountsState,
    persist: () => ManagedDataAccountsState,
    currentActiveAccountId: () => string | null,
    unregisteredDirectory?: string
  ): Promise<ManagedDataAccountsState> {
    if (provider !== 'devin' || this.options.platform !== 'win32') {
      return Promise.resolve(persist())
    }

    return (async () => {
      try {
        await this.apply(next.activeAccountId, unregisteredDirectory)
        return persist()
      } catch (error) {
        let activeAccountId = previous.activeAccountId
        try {
          if (currentActiveAccountId() === next.activeAccountId) {
            activeAccountId = next.activeAccountId
          }
        } catch {
          // Keep the last known selection when registry metadata cannot be read.
        }
        try {
          await this.apply(activeAccountId)
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            'Devin account selection failed and the selected credentials could not be synchronized.',
            { cause: error }
          )
        }
        throw error
      }
    })()
  }

  async remove(
    provider: ManagedDataAccountProvider,
    state: ManagedDataAccountsState,
    accountId: string,
    removeAccount: () => Promise<ManagedDataAccountsState>
  ): Promise<ManagedDataAccountsState> {
    const restoresSystemDevin =
      this.options.platform === 'win32' &&
      provider === 'devin' &&
      (state.activeAccountId === null || state.activeAccountId === accountId)
    if (!restoresSystemDevin) {
      return removeAccount()
    }

    await this.apply(null)
    try {
      return await removeAccount()
    } catch (error) {
      try {
        await this.apply(state.activeAccountId)
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Devin account removal failed and its active credentials could not be restored.',
          { cause: error }
        )
      }
      throw error
    }
  }

  async syncLaunchCredentials(
    provider: ManagedDataAccountProvider,
    selectedEnvironment: Record<string, string>,
    accounts: ManagedDataAccountSummary[]
  ): Promise<void> {
    if (provider !== 'devin' || this.options.platform !== 'win32') {
      return
    }
    const account = accounts.find(
      (candidate) =>
        selectedEnvironment.XDG_DATA_HOME === join(this.options.root, 'devin', candidate.id, 'data')
    )
    await this.apply(account?.id ?? null)
  }

  private async apply(accountId: string | null, unregisteredDirectory?: string): Promise<void> {
    this.assertCredentialStorageOwned()
    if (!accountId) {
      await this.credentialSync.restoreSystemDefault()
      return
    }
    const directory = unregisteredDirectory ?? this.options.accountDirectory(accountId)
    this.options.assertOwned(directory)
    await this.credentialSync.activate(directory)
    this.assertCredentialStorageOwned()
  }

  private assertCredentialStorageOwned(): void {
    for (const path of [
      join(this.options.root, 'devin'),
      join(this.options.root, 'devin', 'system-default-credentials.json'),
      join(this.options.root, 'devin', 'system-default-credentials.toml')
    ]) {
      try {
        this.options.assertOwned(path)
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
          throw error
        }
      }
    }
  }
}
