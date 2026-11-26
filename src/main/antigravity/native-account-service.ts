import { randomUUID } from 'node:crypto'
import type { AntigravityAccountState } from '../../shared/agent-accounts/antigravity/antigravity-account-types'
import {
  parseAntigravityNativeCredential,
  type AntigravityNativeCredential
} from './native-credential-codec'
import { fetchGoogleIdentity } from './google-userinfo-identity'
import { AntigravityRewrittenLoginIdentity } from './native-account-rewritten-login'
import type {
  AntigravityAccountStore,
  AntigravityAccountVault,
  StoredAntigravityAccount
} from './native-account-store'

export type AntigravityCredentialBackend = {
  parse?(contents: string): AntigravityNativeCredential
  read(): Promise<AntigravityNativeCredential | null>
  write(contents: string, expected: string | null): Promise<void>
}

function matches(
  account: StoredAntigravityAccount,
  current: AntigravityNativeCredential,
  parseCredential = parseAntigravityNativeCredential
): boolean {
  if (current.identity && account.subject) {
    return account.subject === current.identity.subject && account.authMethod === current.authMethod
  }
  // agy's token refresh stores no id_token but keeps the grant's refresh token.
  if (
    current.refreshToken &&
    account.authMethod === current.authMethod &&
    parseCredential(account.credentials).refreshToken === current.refreshToken
  ) {
    return true
  }
  return account.credentials === current.contents
}

export class AntigravityAccountService {
  private mutation: Promise<unknown> = Promise.resolve()
  private readonly rewrittenLogins = new AntigravityRewrittenLoginIdentity(
    () => this.lookupIdentity
  )

  constructor(
    private readonly store: AntigravityAccountStore,
    private readonly backend: AntigravityCredentialBackend,
    private readonly now: () => number = Date.now,
    private readonly lookupIdentity = fetchGoogleIdentity
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
      if (vault.accounts.some((entry) => this.matches(entry, current))) {
        return this.state({ vault, current })
      }
      const identity = current.identity ?? (await this.lookupIdentity(current.accessToken))
      if (!current.identity && (await this.backend.read())?.contents !== current.contents) {
        throw new Error('The native Antigravity account changed. Save the current account again.')
      }
      const identified = { ...current, identity }
      const latest = await this.store.read()
      if (!latest.accounts.some((entry) => this.matches(entry, identified))) {
        const timestamp = this.now()
        latest.accounts.push({
          id: randomUUID(),
          email: identity.email,
          subject: identity.subject,
          authMethod: current.authMethod,
          credentials: current.contents,
          createdAt: timestamp,
          updatedAt: timestamp
        })
      }
      this.updateSnapshot(latest, identified)
      await this.store.write(latest)
      return this.state({ vault: latest, current: identified })
    })
  }

  /** `switched` runs once agy holds another login than before and the switch is saved. */
  selectAccount(id: string, switched?: () => void): Promise<AntigravityAccountState> {
    return this.serialize(async () => {
      const { vault, current } = await this.reconcile(id)
      const selected = vault.accounts.find((account) => account.id === id)
      if (!selected) {
        throw new Error('Antigravity account was not found.')
      }
      const { readback, switching } = await this.switchNative(selected, current)
      const latest = await this.store.read()
      if (
        !latest.accounts.some((account) => account.id === id && this.matches(account, readback))
      ) {
        throw new Error('Antigravity snapshots changed during selection; refresh before retrying.')
      }
      latest.selectedAccountId = id
      this.updateSnapshot(latest, readback)
      await this.store.write(latest)
      if (switching) {
        switched?.()
      }
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
      if (current && this.matches(account, current)) {
        throw new Error('Switch agy to another account before removing the one it is signed in to.')
      }
      vault.accounts = vault.accounts.filter((entry) => entry.id !== id)
      // Only Orca's snapshot goes; agy keeps its own login, so a removed selection must stop gating launches.
      if (vault.selectedAccountId === id) {
        vault.selectedAccountId = null
      }
      await this.store.write(vault)
      return this.state({ vault, current })
    })
  }

  prepareForLaunch(): Promise<void> {
    return this.serialize(async () => {
      const { vault, current } = await this.reconcile()
      const selected = vault.accounts.find((account) => account.id === vault.selectedAccountId)
      if (!vault.selectedAccountId || (selected && current && this.matches(selected, current))) {
        return
      }
      // Each running agy writes its own login back to the one native slot on every token refresh.
      // Exactly one saved account holding it (reconcile just saved it) restores the selection, as
      // best effort as selecting: the native store has no compare-and-swap.
      const holders = current ? vault.accounts.filter((entry) => this.matches(entry, current)) : []
      if (!selected || holders.length !== 1) {
        throw new Error(
          'The native Antigravity account changed. Select the account again in Accounts before launching agy.'
        )
      }
      await this.switchNative(selected, current)
      // No vault write: both logins are already saved, and another Orca process selecting meanwhile wins.
      if ((await this.store.read()).selectedAccountId !== selected.id) {
        throw new Error('Antigravity snapshots changed during selection; refresh before retrying.')
      }
    })
  }

  private async switchNative(
    selected: StoredAntigravityAccount,
    current: AntigravityNativeCredential | null
  ) {
    const switching = !current || !this.matches(selected, current)
    if (switching) {
      await this.backend.write(selected.credentials, current?.contents ?? null)
    }
    const readback = await this.backend.read()
    if (!readback || !this.matches(selected, readback)) {
      throw new Error(
        'Antigravity account switching could not be verified; refresh before retrying.'
      )
    }
    return { readback, switching }
  }

  private matches(
    account: StoredAntigravityAccount,
    current: AntigravityNativeCredential
  ): boolean {
    return matches(account, current, this.backend.parse)
  }

  private async reconcile(selectedId?: string) {
    const current = await this.rewrittenLogins.identify(
      await this.backend.read(),
      (await this.store.read()).accounts,
      (account, login) => this.matches(account, login)
    )
    // Re-read after native I/O so a delayed read never restores an older vault.
    const vault = await this.store.read()
    if (selectedId !== undefined) {
      const selected = vault.accounts.find((account) => account.id === selectedId)
      if (!selected) {
        throw new Error('Antigravity account was not found.')
      }
      const parseCredential = this.backend.parse ?? parseAntigravityNativeCredential
      parseCredential(selected.credentials)
    }
    if (current && this.updateSnapshot(vault, current)) {
      await this.store.write(vault)
    }
    return { vault, current }
  }

  private updateSnapshot(
    vault: AntigravityAccountVault,
    current: AntigravityNativeCredential
  ): boolean {
    const account = vault.accounts.find((entry) => this.matches(entry, current))
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
    const active = current
      ? vault.accounts.find((entry) => this.matches(entry, current))
      : undefined
    const subject = current?.identity?.subject ?? active?.subject ?? null
    return {
      accounts: vault.accounts.map((account) => {
        const { credentials: _credentials, ...summary } = account
        return summary
      }),
      activeAccountId: active?.id ?? null,
      selectedAccountId: vault.selectedAccountId,
      currentAccount: current
        ? {
            email: current.identity ? current.identity.email : (active?.email ?? null),
            subject,
            authMethod: current.authMethod,
            identityKnown: subject !== null
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
