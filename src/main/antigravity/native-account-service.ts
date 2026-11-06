import { randomUUID } from 'node:crypto'
import type { AntigravityAccountState } from '../../shared/antigravity-account-types'
import type {
  AntigravityAccountUsage,
  ProviderRateLimits,
  RateLimitRuntimeTarget
} from '../../shared/rate-limit-types'
import {
  ANTIGRAVITY_USAGE_HOST_TARGET,
  type AntigravityUsageLogin,
  type AntigravityUsageReadFinish,
  type AntigravityUsageReadStart
} from '../rate-limits/antigravity-account-usage'
import {
  antigravityUsageLogin,
  storedAntigravityReading,
  withStoredAntigravityReading
} from './native-account-usage-reading'
import {
  parseAntigravityNativeCredential,
  type AntigravityNativeCredential
} from './native-credential-codec'
import { fetchGoogleIdentity } from './google-userinfo-identity'
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

  constructor(
    private readonly store: AntigravityAccountStore,
    private readonly backend: AntigravityCredentialBackend,
    private readonly now: () => number = Date.now,
    private readonly lookupIdentity = fetchGoogleIdentity,
    private readonly target: RateLimitRuntimeTarget = ANTIGRAVITY_USAGE_HOST_TARGET
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
      const latest = this.store.read()
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
      this.store.write(latest)
      return this.state({ vault: latest, current: identified })
    })
  }

  selectAccount(id: string): Promise<AntigravityAccountState> {
    return this.serialize(async () => {
      const { vault, current } = await this.reconcile(id)
      const selected = vault.accounts.find((account) => account.id === id)
      if (!selected) {
        throw new Error('Antigravity account was not found.')
      }
      if (!current || !this.matches(selected, current)) {
        await this.backend.write(selected.credentials, current?.contents ?? null)
      }
      const readback = await this.backend.read()
      if (!readback || !this.matches(selected, readback)) {
        throw new Error(
          'Antigravity account switching could not be verified; refresh before retrying.'
        )
      }
      const latest = this.store.read()
      if (
        !latest.accounts.some((account) => account.id === id && this.matches(account, readback))
      ) {
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
      if (vault.selectedAccountId === id || (current && this.matches(account, current))) {
        throw new Error('Select another Antigravity account before removing this account.')
      }
      const readback = await this.backend.read()
      const latest = this.store.read()
      const latestAccount = latest.accounts.find((entry) => entry.id === id)
      if (!latestAccount) {
        throw new Error('Antigravity account snapshots changed; refresh before retrying.')
      }
      if (latest.selectedAccountId === id || (readback && this.matches(latestAccount, readback))) {
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
      if (!selected || !current || !this.matches(selected, current)) {
        throw new Error(
          'The native Antigravity account changed. Select the account again in Accounts before launching agy.'
        )
      }
    })
  }

  beginUsageRead(): Promise<AntigravityUsageReadStart | null> {
    return this.serialize(async () => {
      if (this.store.read().accounts.length === 0) {
        return null
      }
      const { vault, current } = await this.reconcile()
      return { login: current && this.login(vault, current), accounts: this.usage(vault, current) }
    })
  }

  /** Keeps a successful reading only when the login that started the read is still signed in. */
  finishUsageRead(
    login: AntigravityUsageLogin,
    limits: ProviderRateLimits
  ): Promise<AntigravityUsageReadFinish> {
    return this.serialize(async () => {
      const { vault, current } = await this.reconcile()
      const now = current && this.login(vault, current)
      if (!now || now.key !== login.key) {
        return { switched: true }
      }
      const account = vault.accounts.find((entry) => entry.id === now.accountId)
      if (account && now.accountId === login.accountId && limits.status === 'ok') {
        account.usage = withStoredAntigravityReading(account, this.target, limits)
        this.store.write(vault)
      }
      return {
        switched: false,
        account: { id: now.accountId, email: now.email },
        accounts: this.usage(vault, current)
      }
    })
  }

  private login(
    vault: AntigravityAccountVault,
    current: AntigravityNativeCredential
  ): AntigravityUsageLogin {
    return antigravityUsageLogin(
      vault.accounts.find((entry) => this.matches(entry, current)),
      current
    )
  }

  private usage(
    vault: AntigravityAccountVault,
    current: AntigravityNativeCredential | null
  ): AntigravityAccountUsage[] {
    return vault.accounts.map((account) => ({
      accountId: account.id,
      email: account.email,
      active: current !== null && this.matches(account, current),
      rateLimits: storedAntigravityReading(account, this.target)
    }))
  }

  private matches(
    account: StoredAntigravityAccount,
    current: AntigravityNativeCredential
  ): boolean {
    return matches(account, current, this.backend.parse)
  }

  private async reconcile(selectedId?: string) {
    const current = await this.backend.read()
    // Re-read after native I/O so a delayed read never restores an older vault.
    const vault = this.store.read()
    if (selectedId !== undefined) {
      const selected = vault.accounts.find((account) => account.id === selectedId)
      if (!selected) {
        throw new Error('Antigravity account was not found.')
      }
      const parseCredential = this.backend.parse ?? parseAntigravityNativeCredential
      parseCredential(selected.credentials)
    }
    if (current && this.updateSnapshot(vault, current)) {
      this.store.write(vault)
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
        const { credentials: _credentials, usage: _usage, ...summary } = account
        return { ...summary, usage: storedAntigravityReading(account, this.target) }
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
