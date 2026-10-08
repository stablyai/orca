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
  read(): Promise<AntigravityNativeCredential | null>
  write(contents: string, expected: string | null): Promise<void>
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

  listAccounts(): Promise<AntigravityAccountState> {
    return this.serialize(async () => this.state(await this.reconcile()))
  }

  addCurrentAccount(): Promise<AntigravityAccountState> {
    return this.serialize(async () => {
      const { vault, current } = await this.reconcile()
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
        this.store.write(vault)
      }
      return this.state({ vault, current })
    })
  }

  selectAccount(id: string): Promise<AntigravityAccountState> {
    return this.serialize(async () => {
      const { vault, current } = await this.reconcile()
      const selected = vault.accounts.find((account) => account.id === id)
      if (!selected) {
        throw new Error('Antigravity account was not found.')
      }
      parseAntigravityNativeCredential(selected.credentials)
      if (!current || !matches(selected, current)) {
        await this.backend.write(selected.credentials, current?.contents ?? null)
      }
      const readback = await this.backend.read()
      if (!readback || !matches(selected, readback)) {
        throw new Error(
          'Antigravity account switching could not be verified; refresh before retrying.'
        )
      }
      const latest = this.store.read()
      if (!latest.accounts.some((account) => account.id === id && matches(account, readback))) {
        throw new Error('Antigravity snapshots changed during selection; refresh before retrying.')
      }
      latest.selectedAccountId = id
      this.updateSnapshot(latest, readback)
      this.store.write(latest)
      return this.state({ vault: latest, current: readback })
    })
  }

  removeAccount(id: string): Promise<AntigravityAccountState> {
    return this.serialize(async () => {
      const { vault, current } = await this.reconcile()
      const account = vault.accounts.find((entry) => entry.id === id)
      if (!account) {
        throw new Error('Antigravity account was not found.')
      }
      if (vault.selectedAccountId === id || (current && matches(account, current))) {
        throw new Error('Select another Antigravity account before removing this account.')
      }
      const readback = await this.backend.read()
      const latest = this.store.read()
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
      this.store.write(latest)
      return this.state({ vault: latest, current: readback })
    })
  }

  prepareForLaunch(): Promise<void> {
    return this.serialize(async () => {
      const { vault, current } = await this.reconcile()
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

  private async reconcile() {
    const current = await this.backend.read()
    // Re-read after native I/O so a delayed read never restores an older vault.
    const vault = this.store.read()
    if (current && this.updateSnapshot(vault, current)) {
      this.store.write(vault)
    }
    return { vault, current }
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

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutation.then(operation, operation)
    this.mutation = next.catch(() => undefined)
    return next
  }
}
