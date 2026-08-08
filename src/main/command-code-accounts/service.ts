import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type {
  CommandCodeManagedAccount,
  CommandCodeManagedAccountsState
} from '../../shared/managed-account-types'
import type { Store } from '../persistence'
import { copyCommandCodeAuth, readCommandCodeAuthFile } from './auth-file'
import { assertOwnedCommandCodeAuth, COMMAND_CODE_ACCOUNT_MARKER } from './ownership'

const MAX_LABEL_LENGTH = 120

type CommandCodeAccountStore = Pick<Store, 'getSettings' | 'updateSettings'>

function normalizeLabel(label: string): string {
  const value = label.trim()
  if (
    !value ||
    value.length > MAX_LABEL_LENGTH ||
    value.includes('\u0000') ||
    /[\r\n]/.test(value)
  ) {
    throw new Error('Command Code account label must be 1–120 characters on one line.')
  }
  return value
}

function hardenDirectory(path: string): void {
  if (process.platform !== 'win32') {
    chmodSync(path, 0o700)
  }
}

export class CommandCodeAccountService {
  private mutationQueue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly store: CommandCodeAccountStore,
    private readonly managedAccountsRoot: string
  ) {}

  listAccounts(): CommandCodeManagedAccountsState {
    const settings = this.store.getSettings()
    const accounts = settings.commandCodeManagedAccounts ?? []
    const selectedAccountId = settings.activeCommandCodeManagedAccountId ?? null
    const activeAccountId = accounts.some((account) => account.id === selectedAccountId)
      ? selectedAccountId
      : null
    if (activeAccountId !== settings.activeCommandCodeManagedAccountId) {
      this.store.updateSettings({ activeCommandCodeManagedAccountId: activeAccountId })
    }
    return {
      accounts: accounts.map(({ managedAuthPath: _managedAuthPath, ...summary }) => summary),
      activeAccountId
    }
  }

  getSelectedApiKey(): string | null {
    const settings = this.store.getSettings()
    const accountId = settings.activeCommandCodeManagedAccountId ?? null
    if (!accountId) {
      return null
    }
    const account = (settings.commandCodeManagedAccounts ?? []).find(
      (entry) => entry.id === accountId
    )
    if (!account) {
      throw new Error('Selected Command Code account is no longer available.')
    }
    const authPath = assertOwnedCommandCodeAuth({
      candidatePath: account.managedAuthPath,
      managedAccountsRoot: this.managedAccountsRoot,
      accountId
    })
    return readCommandCodeAuthFile(authPath).apiKey
  }

  addAccountFromHome(sourceHome: string, label: string): Promise<CommandCodeManagedAccountsState> {
    return this.serializeMutation(() => this.importHome(sourceHome, normalizeLabel(label)))
  }

  selectAccount(accountId: string | null): Promise<CommandCodeManagedAccountsState> {
    return this.serializeMutation(async () => {
      if (accountId !== null) {
        this.requireAccount(accountId)
      }
      this.store.updateSettings({ activeCommandCodeManagedAccountId: accountId })
      return this.listAccounts()
    })
  }

  renameAccount(accountId: string, label: string): Promise<CommandCodeManagedAccountsState> {
    return this.serializeMutation(async () => {
      const normalizedLabel = normalizeLabel(label)
      const settings = this.store.getSettings()
      if (
        !(settings.commandCodeManagedAccounts ?? []).some((account) => account.id === accountId)
      ) {
        throw new Error('Unknown Command Code account.')
      }
      const now = Date.now()
      this.store.updateSettings({
        commandCodeManagedAccounts: (settings.commandCodeManagedAccounts ?? []).map((account) =>
          account.id === accountId
            ? { ...account, label: normalizedLabel, updatedAt: now }
            : account
        )
      })
      return this.listAccounts()
    })
  }

  removeAccount(accountId: string): Promise<CommandCodeManagedAccountsState> {
    return this.serializeMutation(async () => {
      const account = this.requireAccount(accountId)
      const ownedAuth = assertOwnedCommandCodeAuth({
        candidatePath: account.managedAuthPath,
        managedAccountsRoot: this.managedAccountsRoot,
        accountId
      })
      rmSync(resolve(ownedAuth, '..'), { recursive: true, force: true })
      const settings = this.store.getSettings()
      this.store.updateSettings({
        commandCodeManagedAccounts: (settings.commandCodeManagedAccounts ?? []).filter(
          (entry) => entry.id !== accountId
        ),
        activeCommandCodeManagedAccountId:
          settings.activeCommandCodeManagedAccountId === accountId
            ? null
            : settings.activeCommandCodeManagedAccountId
      })
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
  ): Promise<CommandCodeManagedAccountsState> {
    const id = randomUUID()
    const accountRoot = join(this.managedAccountsRoot, id)
    const pendingRoot = `${accountRoot}.pending`
    mkdirSync(this.managedAccountsRoot, { recursive: true, mode: 0o700 })
    hardenDirectory(this.managedAccountsRoot)
    try {
      const auth = copyCommandCodeAuth(sourceHome, pendingRoot)
      writeFileSync(join(pendingRoot, COMMAND_CODE_ACCOUNT_MARKER), `${id}\n`, {
        encoding: 'utf-8',
        mode: 0o600
      })
      renameSync(pendingRoot, accountRoot)
      const now = Date.now()
      const account: CommandCodeManagedAccount = {
        id,
        label,
        managedAuthPath: join(accountRoot, 'auth.json'),
        userName: auth.userName,
        createdAt: now,
        updatedAt: now,
        lastAuthenticatedAt: now
      }
      const settings = this.store.getSettings()
      this.store.updateSettings({
        commandCodeManagedAccounts: [...(settings.commandCodeManagedAccounts ?? []), account],
        activeCommandCodeManagedAccountId: account.id
      })
      return this.listAccounts()
    } catch (error) {
      rmSync(pendingRoot, { recursive: true, force: true })
      if (existsSync(accountRoot)) {
        rmSync(accountRoot, { recursive: true, force: true })
      }
      const message = error instanceof Error ? error.message : 'Command Code account import failed.'
      throw new Error(
        message
          .replaceAll(resolve(sourceHome), '[selected home]')
          .replaceAll(pendingRoot, '[managed credential]')
          .replaceAll(accountRoot, '[managed credential]')
          .replaceAll(this.managedAccountsRoot, '[managed accounts]')
      )
    }
  }

  private requireAccount(accountId: string): CommandCodeManagedAccount {
    const account = (this.store.getSettings().commandCodeManagedAccounts ?? []).find(
      (entry) => entry.id === accountId
    )
    if (!account) {
      throw new Error('Unknown Command Code account.')
    }
    return account
  }
}
