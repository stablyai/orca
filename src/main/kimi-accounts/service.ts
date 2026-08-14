import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type {
  KimiManagedAccount,
  KimiManagedAccountsState
} from '../../shared/managed-account-types'
import type { Store } from '../persistence'
import { getHostKimiHome } from '../kimi/kimi-runtime-home'
import { kimiHookService } from '../kimi/hook-service'
import { copyKimiCredentialScope } from './managed-home-copy'
import { assertOwnedKimiManagedHome, KIMI_MANAGED_HOME_MARKER } from './managed-home-ownership'
import { runKimiLogin, type KimiLoginInstructionHandler } from './login-runner'
import {
  provisionKimiManagedLogin,
  type InstallManagedKimiHooks,
  type RunManagedKimiLogin
} from './managed-login-provisioning'

const MAX_LABEL_LENGTH = 120

type KimiAccountStore = Pick<Store, 'getSettings' | 'updateSettings'>
function normalizeLabel(label: string): string {
  const value = label.trim()
  if (
    !value ||
    value.length > MAX_LABEL_LENGTH ||
    value.includes('\u0000') ||
    /[\r\n]/.test(value)
  ) {
    throw new Error('Kimi account label must be 1–120 characters on one line.')
  }
  return value
}

function hardenDirectory(path: string): void {
  if (process.platform !== 'win32') {
    chmodSync(path, 0o700)
  }
}

export class KimiAccountService {
  private mutationQueue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly store: KimiAccountStore,
    private readonly managedAccountsRoot: string,
    private readonly installManagedHooks: InstallManagedKimiHooks = (homePath) =>
      kimiHookService.install(homePath),
    private readonly runManagedLogin: RunManagedKimiLogin = runKimiLogin
  ) {}

  listAccounts(): KimiManagedAccountsState {
    const settings = this.store.getSettings()
    const accounts = settings.kimiManagedAccounts ?? []
    const selectedAccountId = settings.activeKimiManagedAccountId ?? null
    const activeAccountId = accounts.some((account) => account.id === selectedAccountId)
      ? selectedAccountId
      : null
    if (activeAccountId !== settings.activeKimiManagedAccountId) {
      this.store.updateSettings({ activeKimiManagedAccountId: activeAccountId })
    }
    return {
      accounts: accounts.map(
        ({ managedHomePath: _managedHomePath, wslLinuxHomePath: _wslLinuxHomePath, ...summary }) =>
          summary
      ),
      activeAccountId
    }
  }

  getSelectedManagedHomePath(): string | null {
    const settings = this.store.getSettings()
    const accountId = settings.activeKimiManagedAccountId ?? null
    if (!accountId) {
      return null
    }
    const account = (settings.kimiManagedAccounts ?? []).find((entry) => entry.id === accountId)
    if (!account || account.managedHomeRuntime === 'wsl') {
      return null
    }
    return assertOwnedKimiManagedHome({
      candidatePath: account.managedHomePath,
      managedAccountsRoot: this.managedAccountsRoot,
      accountId,
      systemKimiHomePath: getHostKimiHome()
    })
  }

  getManagedHomePathsForSessionDiscovery(): string[] {
    const settings = this.store.getSettings()
    return (settings.kimiManagedAccounts ?? []).flatMap((account) => {
      if (account.managedHomeRuntime === 'wsl') {
        return []
      }
      try {
        return [
          assertOwnedKimiManagedHome({
            candidatePath: account.managedHomePath,
            managedAccountsRoot: this.managedAccountsRoot,
            accountId: account.id,
            systemKimiHomePath: getHostKimiHome()
          })
        ]
      } catch (error) {
        console.warn('[kimi-accounts] Ignoring an invalid managed home during session scan:', error)
        return []
      }
    })
  }

  getInactiveManagedAccountsForUsage(): { id: string; managedHomePath: string }[] {
    const settings = this.store.getSettings()
    const activeAccountId = settings.activeKimiManagedAccountId ?? null
    return (settings.kimiManagedAccounts ?? []).flatMap((account) => {
      if (account.id === activeAccountId || account.managedHomeRuntime === 'wsl') {
        return []
      }
      try {
        return [
          {
            id: account.id,
            managedHomePath: assertOwnedKimiManagedHome({
              candidatePath: account.managedHomePath,
              managedAccountsRoot: this.managedAccountsRoot,
              accountId: account.id,
              systemKimiHomePath: getHostKimiHome()
            })
          }
        ]
      } catch (error) {
        console.warn('[kimi-accounts] Ignoring an invalid managed home during usage fetch:', error)
        return []
      }
    })
  }

  addAccountFromHome(sourceHome: string, label: string): Promise<KimiManagedAccountsState> {
    return this.serializeMutation(() => this.importHome(sourceHome, normalizeLabel(label)))
  }

  addAccountWithLogin(
    label: string,
    onInstructions: KimiLoginInstructionHandler
  ): Promise<KimiManagedAccountsState> {
    return this.serializeMutation(async () => {
      await provisionKimiManagedLogin({
        label: normalizeLabel(label),
        managedAccountsRoot: this.managedAccountsRoot,
        installManagedHooks: this.installManagedHooks,
        runManagedLogin: this.runManagedLogin,
        onInstructions,
        persist: (account) => {
          const settings = this.store.getSettings()
          this.store.updateSettings({
            kimiManagedAccounts: [...(settings.kimiManagedAccounts ?? []), account],
            activeKimiManagedAccountId: account.id
          })
        }
      })
      return this.listAccounts()
    })
  }

  selectAccount(accountId: string | null): Promise<KimiManagedAccountsState> {
    return this.serializeMutation(async () => {
      if (accountId !== null) {
        this.requireAccount(accountId)
      }
      this.store.updateSettings({ activeKimiManagedAccountId: accountId })
      return this.listAccounts()
    })
  }

  renameAccount(accountId: string, label: string): Promise<KimiManagedAccountsState> {
    return this.serializeMutation(async () => {
      const normalizedLabel = normalizeLabel(label)
      const settings = this.store.getSettings()
      if (!(settings.kimiManagedAccounts ?? []).some((account) => account.id === accountId)) {
        throw new Error('Unknown Kimi account.')
      }
      const now = Date.now()
      this.store.updateSettings({
        kimiManagedAccounts: (settings.kimiManagedAccounts ?? []).map((account) =>
          account.id === accountId
            ? { ...account, label: normalizedLabel, updatedAt: now }
            : account
        )
      })
      return this.listAccounts()
    })
  }

  removeAccount(accountId: string): Promise<KimiManagedAccountsState> {
    return this.serializeMutation(async () => {
      const account = this.requireAccount(accountId)
      const ownedHome = assertOwnedKimiManagedHome({
        candidatePath: account.managedHomePath,
        managedAccountsRoot: this.managedAccountsRoot,
        accountId,
        systemKimiHomePath: getHostKimiHome()
      })
      const accountRoot = resolve(ownedHome, '..')
      const child = relative(realpathSync(this.managedAccountsRoot), accountRoot)
      if (child === '' || isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`)) {
        throw new Error('Managed Kimi home is not an owned account directory.')
      }
      rmSync(accountRoot, { recursive: true, force: true })
      const settings = this.store.getSettings()
      this.store.updateSettings({
        kimiManagedAccounts: (settings.kimiManagedAccounts ?? []).filter(
          (entry) => entry.id !== accountId
        ),
        activeKimiManagedAccountId:
          settings.activeKimiManagedAccountId === accountId
            ? null
            : settings.activeKimiManagedAccountId
      })
      return this.listAccounts()
    })
  }

  private serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(operation, operation)
    this.mutationQueue = next.catch(() => {})
    return next
  }

  private async importHome(sourceHome: string, label: string): Promise<KimiManagedAccountsState> {
    const id = randomUUID()
    const accountRoot = join(this.managedAccountsRoot, id)
    const pendingRoot = `${accountRoot}.pending`
    const pendingHome = join(pendingRoot, 'home')
    mkdirSync(this.managedAccountsRoot, { recursive: true, mode: 0o700 })
    hardenDirectory(this.managedAccountsRoot)
    try {
      mkdirSync(pendingRoot, { recursive: false, mode: 0o700 })
      hardenDirectory(pendingRoot)
      copyKimiCredentialScope(sourceHome, pendingHome)
      const markerPath = join(pendingHome, KIMI_MANAGED_HOME_MARKER)
      writeFileSync(markerPath, `${id}\n`, { encoding: 'utf-8', mode: 0o600 })
      if (process.platform !== 'win32') {
        chmodSync(markerPath, 0o600)
      }
      renameSync(pendingRoot, accountRoot)
      const managedHomePath = join(accountRoot, 'home')
      const hookStatus = this.installManagedHooks(managedHomePath)
      if (hookStatus.state !== 'installed') {
        throw new Error(hookStatus.detail ?? 'Could not install hooks in the managed Kimi home.')
      }
      const now = Date.now()
      const account: KimiManagedAccount = {
        id,
        label,
        managedHomePath,
        managedHomeRuntime: 'host',
        wslDistro: null,
        wslLinuxHomePath: null,
        createdAt: now,
        updatedAt: now,
        lastAuthenticatedAt: now
      }
      const settings = this.store.getSettings()
      this.store.updateSettings({
        kimiManagedAccounts: [...(settings.kimiManagedAccounts ?? []), account],
        activeKimiManagedAccountId: account.id
      })
      return this.listAccounts()
    } catch (error) {
      rmSync(pendingRoot, { recursive: true, force: true })
      if (existsSync(accountRoot)) {
        rmSync(accountRoot, { recursive: true, force: true })
      }
      const message = error instanceof Error ? error.message : 'Kimi account import failed.'
      throw new Error(
        message
          .replaceAll(pendingRoot, '[managed home]')
          .replaceAll(accountRoot, '[managed home]')
          .replaceAll(this.managedAccountsRoot, '[managed accounts]')
      )
    }
  }

  private requireAccount(accountId: string): KimiManagedAccount {
    const account = (this.store.getSettings().kimiManagedAccounts ?? []).find(
      (entry) => entry.id === accountId
    )
    if (!account) {
      throw new Error('Unknown Kimi account.')
    }
    return account
  }
}
