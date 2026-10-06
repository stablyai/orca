import {
  remainingAccountOperationMs,
  withAntigravityAccountOperation,
  type AntigravityAccountOperation
} from './native-account-operation'
import { randomUUID } from 'node:crypto'
import type { AntigravityAccountState } from '../../shared/antigravity-account-types'
import {
  parseAntigravityNativeCredential,
  type AntigravityNativeCredential
} from './native-credential-codec'
import type {
  AntigravityAccountStore,
  AntigravityAccountVault,
  StoredAntigravityAccount
} from './native-account-store'

export type AntigravityCredentialBackend = {
  read(operation?: AntigravityAccountOperation): Promise<AntigravityNativeCredential | null>
  write(
    contents: string,
    expected: string | null,
    operation?: AntigravityAccountOperation
  ): Promise<void>
}

function matches(account: StoredAntigravityAccount, current: AntigravityNativeCredential): boolean {
  if (current.identity && account.subject) {
    return account.subject === current.identity.subject && account.authMethod === current.authMethod
  }
  return account.credentials === current.contents
}

export class AntigravityAccountService {
  private mutation: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly store: AntigravityAccountStore,
    private readonly backend: AntigravityCredentialBackend,
    private readonly now: () => number = Date.now
  ) {}

  listAccounts(operation?: AntigravityAccountOperation): Promise<AntigravityAccountState> {
    return this.execute(operation, async (operation) => this.state(await this.reconcile(operation)))
  }

  addCurrentAccount(operation?: AntigravityAccountOperation): Promise<AntigravityAccountState> {
    return this.execute(operation, async (operation) => {
      const { vault, current } = await this.reconcile(operation)
      if (!current) {
        throw new Error('Sign in with agy on this execution host, then save the current account.')
      }
      if (!current.identity) {
        throw new Error(
          'The current Antigravity credential has no stable Google identity; it cannot be saved for switching.'
        )
      }
      let account = vault.accounts.find((entry) => matches(entry, current))
      if (!account) {
        const timestamp = this.now()
        account = {
          id: randomUUID(),
          email: current.identity.email,
          subject: current.identity.subject,
          authMethod: current.authMethod,
          credentials: current.contents,
          createdAt: timestamp,
          updatedAt: timestamp
        }
        vault.accounts.push(account)
        await this.saveVault(vault, operation)
      }
      return this.state({ vault, current })
    })
  }

  selectAccount(
    id: string,
    operation?: AntigravityAccountOperation
  ): Promise<AntigravityAccountState> {
    return this.execute(operation, async (operation) => {
      const { vault, current } = await this.reconcile(operation)
      const selected = vault.accounts.find((account) => account.id === id)
      if (!selected) {
        throw new Error('Antigravity account was not found.')
      }
      parseAntigravityNativeCredential(selected.credentials)
      if (!current || !matches(selected, current)) {
        remainingAccountOperationMs(operation)
        await this.backend.write(selected.credentials, current?.contents ?? null, operation)
      }
      const readback = await this.backend.read(operation)
      if (!readback || !matches(selected, readback)) {
        throw new Error(
          'Antigravity account switching could not be verified; refresh before retrying.'
        )
      }
      const latest = await this.store.read(operation)
      if (!latest.accounts.some((account) => account.id === id && matches(account, readback))) {
        throw new Error('Antigravity snapshots changed during selection; refresh before retrying.')
      }
      latest.selectedAccountId = id
      this.updateSnapshot(latest, readback)
      await this.saveVault(latest, operation)
      return this.state({ vault: latest, current: readback })
    })
  }

  removeAccount(
    id: string,
    operation?: AntigravityAccountOperation
  ): Promise<AntigravityAccountState> {
    return this.execute(operation, async (operation) => {
      const { vault, current } = await this.reconcile(operation)
      const account = vault.accounts.find((entry) => entry.id === id)
      if (!account) {
        throw new Error('Antigravity account was not found.')
      }
      if (vault.selectedAccountId === id || (current && matches(account, current))) {
        throw new Error('Select another Antigravity account before removing this account.')
      }
      const readback = await this.backend.read(operation)
      const latest = await this.store.read(operation)
      const latestAccount = latest.accounts.find((entry) => entry.id === id)
      if (!latestAccount) {
        throw new Error('Antigravity account snapshots changed; refresh before retrying.')
      }
      if (latest.selectedAccountId === id || (readback && matches(latestAccount, readback))) {
        throw new Error('Select another Antigravity account before removing this account.')
      }
      if (readback) {
        this.updateSnapshot(latest, readback)
      }
      latest.accounts = latest.accounts.filter((entry) => entry.id !== id)
      await this.saveVault(latest, operation)
      return this.state({ vault: latest, current: readback })
    })
  }

  prepareForLaunch(operation?: AntigravityAccountOperation): Promise<void> {
    return this.execute(operation, async (operation) => {
      const { vault, current } = await this.reconcile(operation)
      if (!vault.selectedAccountId) {
        return
      }
      const selected = vault.accounts.find((account) => account.id === vault.selectedAccountId)
      if (!selected || !current || !matches(selected, current)) {
        throw new Error(
          'The native Antigravity account changed. Select the account again in Accounts before launching agy.'
        )
      }
    })
  }

  private async reconcile(operation: AntigravityAccountOperation) {
    const current = await this.backend.read(operation)
    // Re-read after native I/O so a delayed read never restores an older vault.
    const vault = await this.store.read(operation)
    if (current && this.updateSnapshot(vault, current)) {
      await this.saveVault(vault, operation)
    }
    return { vault, current }
  }

  private async saveVault(
    vault: AntigravityAccountVault,
    operation: AntigravityAccountOperation
  ): Promise<void> {
    remainingAccountOperationMs(operation)
    await this.store.write(vault, operation)
  }

  private updateSnapshot(
    vault: AntigravityAccountVault,
    current: AntigravityNativeCredential
  ): boolean {
    const account = vault.accounts.find((entry) => matches(entry, current))
    if (!account || account.credentials === current.contents) {
      return false
    }
    account.credentials = current.contents
    account.email = current.identity?.email ?? account.email
    account.updatedAt = this.now()
    return true
  }

  private state({
    vault,
    current
  }: {
    vault: AntigravityAccountVault
    current: AntigravityNativeCredential | null
  }): AntigravityAccountState {
    return {
      accounts: vault.accounts.map(({ credentials: _credentials, ...account }) => account),
      activeAccountId: current
        ? (vault.accounts.find((entry) => matches(entry, current))?.id ?? null)
        : null,
      selectedAccountId: vault.selectedAccountId,
      currentAccount: current
        ? {
            email: current.identity?.email ?? null,
            subject: current.identity?.subject ?? null,
            authMethod: current.authMethod,
            identityKnown: current.identity !== null
          }
        : null
    }
  }

  private execute<T>(
    operation: AntigravityAccountOperation | undefined,
    action: (operation: AntigravityAccountOperation) => Promise<T>
  ): Promise<T> {
    if (!operation) {
      return withAntigravityAccountOperation((context) => this.execute(context, action))
    }
    return this.serialize(async () => {
      remainingAccountOperationMs(operation)
      const result = await action(operation)
      remainingAccountOperationMs(operation)
      return result
    })
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutation.then(operation, operation)
    this.mutation = next.catch(() => undefined)
    return next
  }
}
