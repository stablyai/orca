/* eslint-disable max-lines -- Why: this service intentionally keeps OpenCode
account lifecycle, credential-file writes, and managed-path safety together so
the trusted boundary around Orca-managed API keys stays easy to audit. */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { app } from 'electron'
import type {
  OpenCodeAccountsState,
  OpenCodeManagedAccount,
  OpenCodeManagedAccountSummary
} from '../../shared/types'
import type { Store } from '../persistence'

const OPENCODE_PROVIDER_ID = 'opencode-go'

function normalizeField(value: string): string {
  return value.trim()
}

function formatKeyHint(apiKey: string): string {
  const trimmed = normalizeField(apiKey)
  if (trimmed.length <= 8) {
    return trimmed
  }
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`
}

export class OpenCodeAccountService {
  constructor(private readonly store: Store) {}

  listAccounts(): OpenCodeAccountsState {
    this.normalizeActiveSelection()
    return this.getSnapshot()
  }

  addAccount(input: { label: string; apiKey: string }): OpenCodeAccountsState {
    const label = this.requireLabel(input.label)
    const apiKey = this.requireApiKey(input.apiKey)
    const accountId = randomUUID()
    const managedDataPath = this.createManagedDataRoot(accountId)

    try {
      this.writeManagedAuthFile(managedDataPath, apiKey)
      const now = Date.now()
      const account: OpenCodeManagedAccount = {
        id: accountId,
        label,
        managedDataPath,
        providerId: OPENCODE_PROVIDER_ID,
        keyHint: formatKeyHint(apiKey),
        createdAt: now,
        updatedAt: now,
        lastAuthenticatedAt: now
      }

      const settings = this.store.getSettings()
      this.store.updateSettings({
        openCodeManagedAccounts: [...settings.openCodeManagedAccounts, account],
        activeOpenCodeManagedAccountId: account.id
      })

      return this.getSnapshot()
    } catch (error) {
      this.safeRemoveManagedDataRoot(managedDataPath)
      throw error
    }
  }

  reauthenticateAccount(
    accountId: string,
    input: { label: string; apiKey: string }
  ): OpenCodeAccountsState {
    const account = this.requireAccount(accountId)
    const label = this.requireLabel(input.label)
    const apiKey = this.requireApiKey(input.apiKey)
    const managedDataPath = this.assertManagedDataPath(account.managedDataPath)
    this.writeManagedAuthFile(managedDataPath, apiKey)

    const settings = this.store.getSettings()
    const now = Date.now()
    this.store.updateSettings({
      openCodeManagedAccounts: settings.openCodeManagedAccounts.map((entry) =>
        entry.id === accountId
          ? {
              ...entry,
              label,
              keyHint: formatKeyHint(apiKey),
              updatedAt: now,
              lastAuthenticatedAt: now
            }
          : entry
      )
    })

    return this.getSnapshot()
  }

  removeAccount(accountId: string): OpenCodeAccountsState {
    const account = this.requireAccount(accountId)
    const settings = this.store.getSettings()
    const nextAccounts = settings.openCodeManagedAccounts.filter((entry) => entry.id !== accountId)
    const nextActiveId =
      settings.activeOpenCodeManagedAccountId === accountId
        ? null
        : settings.activeOpenCodeManagedAccountId

    this.safeRemoveManagedDataRoot(account.managedDataPath, account.id)
    this.store.updateSettings({
      openCodeManagedAccounts: nextAccounts,
      activeOpenCodeManagedAccountId: nextActiveId
    })
    return this.getSnapshot()
  }

  selectAccount(accountId: string | null): OpenCodeAccountsState {
    if (accountId !== null) {
      this.requireAccount(accountId)
    }

    this.store.updateSettings({
      activeOpenCodeManagedAccountId: accountId
    })

    return this.getSnapshot()
  }

  getSelectedManagedDataPath(): string | null {
    const account = this.getActiveAccount()
    if (!account) {
      return null
    }

    try {
      return this.assertManagedDataPath(account.managedDataPath, account.id)
    } catch (error) {
      // Why: if the managed OpenCode data root disappears or is tampered with,
      // the safest fallback is to clear Orca's override and let terminals use
      // the ambient system OpenCode state instead of keeping a broken account
      // selected.
      this.store.updateSettings({ activeOpenCodeManagedAccountId: null })
      console.warn('[opencode-accounts] Ignoring invalid managed data root:', error)
      return null
    }
  }

  private getSnapshot(): OpenCodeAccountsState {
    const settings = this.store.getSettings()
    return {
      accounts: settings.openCodeManagedAccounts
        .map((account) => this.toSummary(account))
        .sort((a, b) => b.updatedAt - a.updatedAt),
      activeAccountId: settings.activeOpenCodeManagedAccountId
    }
  }

  private getActiveAccount(): OpenCodeManagedAccount | null {
    this.normalizeActiveSelection()
    const settings = this.store.getSettings()
    if (!settings.activeOpenCodeManagedAccountId) {
      return null
    }
    return (
      settings.openCodeManagedAccounts.find(
        (entry) => entry.id === settings.activeOpenCodeManagedAccountId
      ) ?? null
    )
  }

  private toSummary(account: OpenCodeManagedAccount): OpenCodeManagedAccountSummary {
    return {
      id: account.id,
      label: account.label,
      providerId: account.providerId,
      keyHint: account.keyHint,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
      lastAuthenticatedAt: account.lastAuthenticatedAt
    }
  }

  private requireAccount(accountId: string): OpenCodeManagedAccount {
    const settings = this.store.getSettings()
    const account = settings.openCodeManagedAccounts.find((entry) => entry.id === accountId)
    if (!account) {
      throw new Error('That OpenCode account no longer exists.')
    }
    return account
  }

  private normalizeActiveSelection(): void {
    const settings = this.store.getSettings()
    if (!settings.activeOpenCodeManagedAccountId) {
      return
    }
    const hasActiveAccount = settings.openCodeManagedAccounts.some(
      (entry) => entry.id === settings.activeOpenCodeManagedAccountId
    )
    if (!hasActiveAccount) {
      this.store.updateSettings({ activeOpenCodeManagedAccountId: null })
    }
  }

  private requireLabel(label: string): string {
    const normalized = normalizeField(label)
    if (!normalized) {
      throw new Error('OpenCode account label is required.')
    }
    return normalized
  }

  private requireApiKey(apiKey: string): string {
    const normalized = normalizeField(apiKey)
    if (!normalized) {
      throw new Error('OpenCode Go API key is required.')
    }
    return normalized
  }

  private getManagedAccountsRoot(): string {
    const root = join(app.getPath('userData'), 'opencode-accounts')
    mkdirSync(root, { recursive: true })
    return root
  }

  private createManagedDataRoot(accountId: string): string {
    const managedDataPath = join(this.getManagedAccountsRoot(), accountId, 'xdg-data')
    mkdirSync(managedDataPath, { recursive: true })
    // Why: OpenCode's XDG data root is not a single auth file. Leaving an
    // ownership marker at the managed root lets Orca later prove the path is
    // one it created before deleting anything recursively.
    writeFileSync(join(managedDataPath, '.orca-managed-opencode-data'), `${accountId}\n`, 'utf-8')
    return this.assertManagedDataPath(managedDataPath, accountId)
  }

  private assertManagedDataPath(candidatePath: string, expectedAccountId?: string): string {
    const rootPath = this.getManagedAccountsRoot()
    const resolvedCandidate = resolve(candidatePath)
    const resolvedRoot = resolve(rootPath)
    const canonicalCandidate = realpathSync(resolvedCandidate)
    const canonicalRoot = realpathSync(resolvedRoot)
    const relativePath = relative(canonicalRoot, canonicalCandidate)
    const escaped =
      relativePath === '' ||
      relativePath === '.' ||
      relativePath.startsWith('..') ||
      relativePath.includes(`..${sep}`)

    if (escaped) {
      throw new Error('Managed OpenCode data root escaped Orca account storage.')
    }

    const markerPath = join(canonicalCandidate, '.orca-managed-opencode-data')
    if (!existsSync(markerPath)) {
      throw new Error('Managed OpenCode data root is missing Orca ownership marker.')
    }
    if (expectedAccountId) {
      const markerAccountId = readFileSync(markerPath, 'utf-8').trim()
      if (markerAccountId !== expectedAccountId) {
        throw new Error('Managed OpenCode data root marker did not match the saved account id.')
      }
    }

    return canonicalCandidate
  }

  private writeManagedAuthFile(managedDataPath: string, apiKey: string): void {
    const canonicalManagedDataPath = this.assertManagedDataPath(managedDataPath)
    const providerDir = join(canonicalManagedDataPath, 'opencode')
    mkdirSync(providerDir, { recursive: true })
    writeFileSync(
      join(providerDir, 'auth.json'),
      JSON.stringify(
        {
          [OPENCODE_PROVIDER_ID]: {
            type: 'api',
            key: apiKey
          }
        },
        null,
        2
      ),
      'utf-8'
    )
  }

  private safeRemoveManagedDataRoot(candidatePath: string, expectedAccountId: string): void {
    let managedDataPath: string
    try {
      managedDataPath = this.assertManagedDataPath(candidatePath, expectedAccountId)
    } catch (error) {
      console.warn('[opencode-accounts] Refusing to remove untrusted managed data root:', error)
      throw error
    }

    try {
      rmSync(managedDataPath, { recursive: true, force: true })
    } catch (error) {
      console.warn('[opencode-accounts] Failed to remove managed data root:', error)
      throw new Error('OpenCode account removal failed while deleting the managed data root.')
    }
  }
}
