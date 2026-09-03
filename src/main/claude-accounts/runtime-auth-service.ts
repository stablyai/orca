import { readFileSync } from 'node:fs'
import type { Store } from '../persistence'
import {
  getSelectedClaudeAccountIdForTarget,
  type ClaudeAccountSelectionTarget
} from './runtime-selection'
import { ClaudeRuntimeAuthSync } from './runtime-auth/runtime-auth-sync'
import type { ClaudeRuntimeAuthPreparation } from './runtime-auth/runtime-auth-types'
import { migrateLegacySharedClaudeAuth } from './legacy-shared-claude-auth-migration'
import {
  readActiveClaudeKeychainCredentialsStrict,
  readManagedClaudeKeychainCredentials
} from './keychain'
import { migrateClaudeAccountsToScopedStore } from './per-account-claude-store-migration'
import {
  claudeCredentialsUnavailable,
  readComposedClaudeCredentials
} from './claude-credential-read-result'
import { readClaudeManagedAuthFile } from './managed-auth-path'

export type { ClaudeRuntimeAuthPreparation } from './runtime-auth/runtime-auth-types'

export class ClaudeRuntimeAuthService extends ClaudeRuntimeAuthSync {
  private readonly startupMigrations: Promise<void>

  constructor(store: Store) {
    super(store)
    this.initializeLastSyncedState()
    this.startupMigrations = this.runStartupMigrations()
    void this.startupMigrations
  }

  /**
   * Order matters and is not incidental: sync first so migration cannot race a cleanup and
   * repopulate an account from a stale shared entry; then drain the shared `~/.claude` store into
   * per-account storage; only then move accounts onto the CLI-owned scoped store. Running the
   * scoped migration first would copy an account's older id-keyed value while its newer credential
   * was still sitting in the shared home.
   */
  private async runStartupMigrations(): Promise<void> {
    await this.safeSyncForCurrentSelection()
    await this.migrateLegacySharedAuth()
    await this.migrateToScopedStore()
  }

  /**
   * Readers must await this. An account whose credential has not been copied yet reads as signed
   * out, and that answer can be cached long after the copy lands.
   */
  async whenStartupMigrationsComplete(): Promise<void> {
    await this.startupMigrations
  }

  private async migrateToScopedStore(): Promise<void> {
    if (process.platform !== 'darwin') {
      return
    }
    try {
      await migrateClaudeAccountsToScopedStore({
        accounts: this.store.getSettings().claudeManagedAccounts,
        metadataDir: this.getRuntimeMetadataDir(),
        readIdKeyedCredentials: (accountId) => readManagedClaudeKeychainCredentials(accountId),
        readDestination: async (account) => {
          const managedAuthPath = await this.getOwnedManagedAuthPath(account)
          if (!managedAuthPath) {
            return claudeCredentialsUnavailable('ownership-indeterminate')
          }
          return readComposedClaudeCredentials({
            readScopedKeychain: () => readActiveClaudeKeychainCredentialsStrict(managedAuthPath),
            readSameHomeFile: () => readClaudeManagedAuthFile(managedAuthPath, '.credentials.json')
          })
        },
        writeDestination: (account, credentialsJson) =>
          this.writeManagedCredentials(account, credentialsJson)
      })
    } catch (error) {
      // Fail open: an account that did not migrate is retried next start.
      console.warn('[claude-runtime-auth] Per-account Claude store migration failed:', error)
    }
  }

  async prepareForClaudeLaunch(
    target?: ClaudeAccountSelectionTarget
  ): Promise<ClaudeRuntimeAuthPreparation> {
    await this.whenStartupMigrationsComplete()
    const effectiveTarget = target ?? this.getDefaultAccountSelectionTarget()
    const settings = this.store.getSettings()
    const selectedId = getSelectedClaudeAccountIdForTarget(settings, effectiveTarget)
    const selected = selectedId
      ? settings.claudeManagedAccounts.find((account) => account.id === selectedId)
      : null
    // Isolated accounts are already Claude's runtime store; legacy accounts
    // with valid credentials still use the shared runtime before launch.
    const legacyCredentials =
      selected && selected.managedAuthRuntime === undefined
        ? await this.readManagedCredentials(selected)
        : null
    let cleanupMissingLegacy = false
    if (selected && selected.managedAuthRuntime === undefined && legacyCredentials === null) {
      const runtimeCredentials = this.readRuntimeCredentialsFile()
      const managedOauth = await this.readManagedOauthAccount(selected)
      cleanupMissingLegacy = this.runtimeCredentialsBelongToAccount(
        runtimeCredentials,
        selected,
        managedOauth
      )
    }
    if (
      !selected ||
      selected.managedAuthRuntime === 'wsl' ||
      (selected.managedAuthRuntime === undefined &&
        legacyCredentials !== null &&
        this.isValidCredentialsJsonObject(legacyCredentials)) ||
      cleanupMissingLegacy
    ) {
      await this.syncForCurrentSelection(effectiveTarget)
    }
    const preparation = this.getPreparation(effectiveTarget)
    return preparation
  }

  async prepareForRateLimitFetch(
    target?: ClaudeAccountSelectionTarget
  ): Promise<ClaudeRuntimeAuthPreparation> {
    await this.whenStartupMigrationsComplete()
    const effectiveTarget = target ?? this.getDefaultAccountSelectionTarget()
    // Rate-limit reads must never materialize or refresh credentials.
    return this.getPreparation(effectiveTarget)
  }

  async syncForCurrentSelection(target?: ClaudeAccountSelectionTarget): Promise<void> {
    await this.serializeMutation(() =>
      this.doSyncForCurrentSelection(target ?? this.getDefaultAccountSelectionTarget())
    )
  }

  async forceMaterializeCurrentSelectionForRollback(): Promise<void> {
    await this.serializeMutation(async () => {
      const settings = this.store.getSettings()
      if (!settings.activeClaudeManagedAccountId) {
        const previousAccount = this.getActiveAccount(
          settings.claudeManagedAccounts,
          this.lastSyncedAccountId
        )
        await this.restoreSystemDefaultSnapshot(
          previousAccount ? await this.readManagedCredentials(previousAccount) : null,
          previousAccount ? await this.readManagedOauthAccount(previousAccount) : undefined
        )
        this.lastSyncedAccountId = null
        return
      }
      await this.doSyncForCurrentSelection()
    })
  }

  getRuntimeConfigDir(target?: ClaudeAccountSelectionTarget): string {
    return this.getPreparation(target).configDir
  }

  private initializeLastSyncedState(): void {
    const settings = this.store.getSettings()
    this.lastSyncedAccountId = getSelectedClaudeAccountIdForTarget(settings, { runtime: 'host' })
  }

  private async safeSyncForCurrentSelection(): Promise<void> {
    try {
      await this.syncForCurrentSelection()
    } catch {
      console.warn('[claude-runtime-auth] Failed to sync runtime auth state')
    }
  }

  private async migrateLegacySharedAuth(): Promise<void> {
    const settings = this.store.getSettings()
    const paths = this.pathResolver.getRuntimePaths()
    const metadataDir = this.getRuntimeMetadataDir()
    try {
      await migrateLegacySharedClaudeAuth({
        accounts: settings.claudeManagedAccounts,
        activeAccountId: settings.activeClaudeManagedAccountId,
        sharedAuthPath: paths.credentialsPath,
        metadataDir,
        readLegacyKeychain:
          process.platform === 'darwin'
            ? () => readActiveClaudeKeychainCredentialsStrict()
            : undefined,
        readLegacyOauthAccount: () => {
          try {
            const parsed = JSON.parse(readFileSync(paths.configPath, 'utf-8')) as Record<
              string,
              unknown
            >
            return parsed.oauthAccount ?? null
          } catch {
            return null
          }
        },
        readManagedCredentials: (account) => this.readManagedCredentials(account),
        writeManagedCredentials: (account, contents) =>
          this.writeManagedCredentials(account, contents)
      })
    } catch {
      console.warn('[claude-runtime-auth] Legacy auth migration deferred')
    }
  }

  private serializeMutation<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(fn, fn)
    this.mutationQueue = next.catch(() => {})
    return next
  }

  // Why: re-auth/add-account write fresh managed tokens; skip the next read-back so stale runtime tokens can't overwrite them.
  clearLastWrittenCredentialsJson(
    accountId = this.store.getSettings().activeClaudeManagedAccountId
  ): void {
    if (accountId === this.store.getSettings().activeClaudeManagedAccountId) {
      this.lastWrittenCredentialsJson = null
    }
    this.skipNextReadBackForAccountId = accountId
  }
}
