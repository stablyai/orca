import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type {
  ManagedCliHomeAccount,
  ManagedCliHomeAccountsState,
  ManagedCliHomeProvider
} from '../../shared/managed-account-types'
import type { Store } from '../persistence'
import { copyManagedProviderCredentialScope } from './credential-scope'
import { assertOwnedManagedProviderHome, MANAGED_PROVIDER_HOME_MARKER } from './ownership'

const MAX_LABEL_LENGTH = 120

type AccountStore = Pick<Store, 'getSettings' | 'updateSettings'>

function normalizeLabel(label: string): string {
  const value = label.trim()
  if (
    !value ||
    value.length > MAX_LABEL_LENGTH ||
    value.includes('\u0000') ||
    /[\r\n]/.test(value)
  ) {
    throw new Error('Provider account label must be 1–120 characters on one line.')
  }
  return value
}

function hardenDirectory(path: string): void {
  if (process.platform !== 'win32') {
    chmodSync(path, 0o700)
  }
}

function getAccounts(
  settings: GlobalSettings,
  provider: ManagedCliHomeProvider
): ManagedCliHomeAccount[] {
  return provider === 'grok'
    ? (settings.grokManagedAccounts ?? [])
    : (settings.geminiManagedAccounts ?? [])
}

function getActiveAccountId(
  settings: GlobalSettings,
  provider: ManagedCliHomeProvider
): string | null {
  return provider === 'grok'
    ? (settings.activeGrokManagedAccountId ?? null)
    : (settings.activeGeminiManagedAccountId ?? null)
}

function accountSettingsUpdate(
  provider: ManagedCliHomeProvider,
  accounts: ManagedCliHomeAccount[],
  activeAccountId: string | null
): Partial<GlobalSettings> {
  return provider === 'grok'
    ? { grokManagedAccounts: accounts, activeGrokManagedAccountId: activeAccountId }
    : { geminiManagedAccounts: accounts, activeGeminiManagedAccountId: activeAccountId }
}

export class ManagedCliHomeAccountService {
  private mutationQueue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly store: AccountStore,
    readonly provider: ManagedCliHomeProvider,
    private readonly managedAccountsRoot: string
  ) {}

  listAccounts(): ManagedCliHomeAccountsState {
    const settings = this.store.getSettings()
    const accounts = getAccounts(settings, this.provider)
    const selectedAccountId = getActiveAccountId(settings, this.provider)
    const activeAccountId = accounts.some((account) => account.id === selectedAccountId)
      ? selectedAccountId
      : null
    if (activeAccountId !== selectedAccountId) {
      this.store.updateSettings(accountSettingsUpdate(this.provider, accounts, activeAccountId))
    }
    return {
      accounts: accounts.map(({ managedHomePath: _managedHomePath, ...summary }) => summary),
      activeAccountId
    }
  }

  getSelectedManagedHomePath(): string | null {
    const settings = this.store.getSettings()
    const accountId = getActiveAccountId(settings, this.provider)
    if (!accountId) {
      return null
    }
    const account = getAccounts(settings, this.provider).find((entry) => entry.id === accountId)
    if (!account) {
      throw new Error(`Selected ${this.provider} account is no longer available.`)
    }
    return assertOwnedManagedProviderHome({
      provider: this.provider,
      candidatePath: account.managedHomePath,
      managedAccountsRoot: this.managedAccountsRoot,
      accountId,
      systemHomePath: this.getSystemHomePath()
    })
  }

  addAccountFromHome(sourceHome: string, label: string): Promise<ManagedCliHomeAccountsState> {
    return this.serializeMutation(() => this.importHome(sourceHome, normalizeLabel(label)))
  }

  selectAccount(accountId: string | null): Promise<ManagedCliHomeAccountsState> {
    return this.serializeMutation(async () => {
      const settings = this.store.getSettings()
      const accounts = getAccounts(settings, this.provider)
      if (accountId !== null && !accounts.some((account) => account.id === accountId)) {
        throw new Error(`Unknown ${this.provider} account.`)
      }
      this.store.updateSettings(accountSettingsUpdate(this.provider, accounts, accountId))
      return this.listAccounts()
    })
  }

  renameAccount(accountId: string, label: string): Promise<ManagedCliHomeAccountsState> {
    return this.serializeMutation(async () => {
      const normalizedLabel = normalizeLabel(label)
      const settings = this.store.getSettings()
      const accounts = getAccounts(settings, this.provider)
      if (!accounts.some((account) => account.id === accountId)) {
        throw new Error(`Unknown ${this.provider} account.`)
      }
      const now = Date.now()
      const nextAccounts = accounts.map((account) =>
        account.id === accountId ? { ...account, label: normalizedLabel, updatedAt: now } : account
      )
      this.store.updateSettings(
        accountSettingsUpdate(
          this.provider,
          nextAccounts,
          getActiveAccountId(settings, this.provider)
        )
      )
      return this.listAccounts()
    })
  }

  removeAccount(accountId: string): Promise<ManagedCliHomeAccountsState> {
    return this.serializeMutation(async () => {
      const settings = this.store.getSettings()
      const accounts = getAccounts(settings, this.provider)
      const account = accounts.find((entry) => entry.id === accountId)
      if (!account) {
        throw new Error(`Unknown ${this.provider} account.`)
      }
      const ownedHome = assertOwnedManagedProviderHome({
        provider: this.provider,
        candidatePath: account.managedHomePath,
        managedAccountsRoot: this.managedAccountsRoot,
        accountId,
        systemHomePath: this.getSystemHomePath()
      })
      rmSync(resolve(ownedHome, '..'), { recursive: true, force: true })
      const nextAccounts = accounts.filter((entry) => entry.id !== accountId)
      const nextActiveId =
        getActiveAccountId(settings, this.provider) === accountId
          ? null
          : getActiveAccountId(settings, this.provider)
      this.store.updateSettings(accountSettingsUpdate(this.provider, nextAccounts, nextActiveId))
      return this.listAccounts()
    })
  }

  private serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(operation, operation)
    this.mutationQueue = next.catch(() => {})
    return next
  }

  private async importHome(
    sourceHome: string,
    label: string
  ): Promise<ManagedCliHomeAccountsState> {
    const id = randomUUID()
    const accountRoot = join(this.managedAccountsRoot, id)
    const pendingRoot = `${accountRoot}.pending`
    const pendingHome = join(pendingRoot, 'home')
    mkdirSync(this.managedAccountsRoot, { recursive: true, mode: 0o700 })
    hardenDirectory(this.managedAccountsRoot)
    try {
      mkdirSync(pendingRoot, { recursive: false, mode: 0o700 })
      copyManagedProviderCredentialScope({
        provider: this.provider,
        sourceHome,
        destinationHome: pendingHome
      })
      writeFileSync(join(pendingHome, MANAGED_PROVIDER_HOME_MARKER), `${this.provider}:${id}\n`, {
        encoding: 'utf-8',
        mode: 0o600
      })
      renameSync(pendingRoot, accountRoot)
      const now = Date.now()
      const account: ManagedCliHomeAccount = {
        id,
        provider: this.provider,
        label,
        managedHomePath: join(accountRoot, 'home'),
        createdAt: now,
        updatedAt: now,
        lastAuthenticatedAt: now
      }
      const settings = this.store.getSettings()
      const nextAccounts = [...getAccounts(settings, this.provider), account]
      this.store.updateSettings(accountSettingsUpdate(this.provider, nextAccounts, id))
      return this.listAccounts()
    } catch (error) {
      rmSync(pendingRoot, { recursive: true, force: true })
      rmSync(accountRoot, { recursive: true, force: true })
      const message = error instanceof Error ? error.message : 'Provider account import failed.'
      throw new Error(
        message
          .replaceAll(resolve(sourceHome), '[selected home]')
          .replaceAll(pendingRoot, '[managed home]')
          .replaceAll(accountRoot, '[managed home]')
          .replaceAll(this.managedAccountsRoot, '[managed accounts]')
      )
    }
  }

  private getSystemHomePath(): string {
    if (this.provider === 'grok') {
      return process.env.GROK_HOME?.trim() || join(homedir(), '.grok')
    }
    return process.env.GEMINI_CLI_HOME?.trim() || homedir()
  }
}
