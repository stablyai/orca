import type { Store } from '../persistence'
import { assertClaudeProfileCli } from './claude-profile-cli'
import {
  getSelectedClaudeAccountIdForTarget,
  type ClaudeAccountSelectionTarget
} from './runtime-selection'
import { ClaudeRuntimeAuthSync } from './runtime-auth/runtime-auth-sync'
import type { ClaudeRuntimeAuthPreparation } from './runtime-auth/runtime-auth-types'
import { hasLiveLegacyClaudePtys } from './live-pty-gate'
import { withClaudeAccountCredentialMutation } from './account-credential-mutation'
import { enrollIsolatedClaudeAccount, hasIsolatedClaudeAccountAuth } from './isolated-account-auth'

export type { ClaudeRuntimeAuthPreparation } from './runtime-auth/runtime-auth-types'

export class ClaudeRuntimeAuthService extends ClaudeRuntimeAuthSync {
  constructor(store: Pick<Store, 'getSettings' | 'updateSettings'>) {
    super(store)
    this.initializeLastSyncedState()
    void this.safeSyncForCurrentSelection()
  }

  async prepareForClaudeLaunch(
    target?: ClaudeAccountSelectionTarget
  ): Promise<ClaudeRuntimeAuthPreparation> {
    const effectiveTarget = target ?? this.getDefaultAccountSelectionTarget()
    const settings = this.store.getSettings()
    const account = this.getActiveAccount(
      settings.claudeManagedAccounts,
      getSelectedClaudeAccountIdForTarget(settings, effectiveTarget)
    )
    if (
      account &&
      account.managedAuthRuntime !== 'wsl' &&
      hasIsolatedClaudeAccountAuth(account.managedAuthPath)
    ) {
      return this.prepareForClaudeProfileLaunch(account.id, effectiveTarget)
    }
    await this.syncForCurrentSelection(effectiveTarget)
    return this.getPreparation(effectiveTarget)
  }

  async prepareForRateLimitFetch(
    target?: ClaudeAccountSelectionTarget
  ): Promise<ClaudeRuntimeAuthPreparation> {
    const effectiveTarget = target ?? this.getDefaultAccountSelectionTarget()
    await this.syncForCurrentSelection(effectiveTarget)
    return this.getPreparation(effectiveTarget)
  }

  async prepareForClaudeProfileLaunch(
    accountId: string,
    target?: ClaudeAccountSelectionTarget
  ): Promise<ClaudeRuntimeAuthPreparation> {
    if (process.platform === 'win32') {
      throw new Error('Claude launch profiles currently require macOS or Linux.')
    }
    return withClaudeAccountCredentialMutation(accountId, () =>
      this.serializeMutation(async () => {
        const account = this.getActiveAccount(
          this.store.getSettings().claudeManagedAccounts,
          accountId
        )
        if (!account) {
          throw new Error(
            'That Claude account no longer exists. Reconnect the profile in Agent settings.'
          )
        }
        if (target?.runtime === 'wsl' || account.managedAuthRuntime === 'wsl') {
          throw new Error(
            'Claude launch profiles are not yet supported in WSL. Use the host runtime for this profile.'
          )
        }
        const path = await this.getOwnedManagedAuthPath(account)
        if (!path) {
          throw new Error('Managed Claude auth storage is not owned by Orca.')
        }
        if (!hasIsolatedClaudeAccountAuth(path)) {
          await assertClaudeProfileCli()
          if (hasLiveLegacyClaudePtys()) {
            throw new Error(
              'Close existing Claude sessions before using this account in a profile for the first time.'
            )
          }
          // Preserve a legacy CLI refresh before making the scoped credential authoritative.
          if (this.lastSyncedAccountId === account.id) {
            await this.doSyncForCurrentSelection({ runtime: 'host' })
          }
          if (this.lastSyncedAccountId === account.id) {
            this.store.updateSettings({ claudeProfileMigrationAt: Date.now() })
            await this.restoreSystemDefaultSnapshot(
              await this.readManagedCredentials(account),
              await this.readManagedOauthAccount(account)
            )
            this.lastSyncedAccountId = null
          }
          await enrollIsolatedClaudeAccount(
            { accountId, managedAuthPath: path },
            { oauthAccount: await this.readManagedOauthAccount(account) }
          )
        }
        const credentials = await this.readManagedCredentials(account)
        if (!credentials || !this.isValidCredentialsJsonObject(credentials)) {
          throw new Error(
            'This Claude account has no valid credential. Reconnect it before launching.'
          )
        }
        return {
          configDir: path,
          runtime: 'host',
          wslDistro: null,
          wslLinuxConfigDir: null,
          envPatch: { CLAUDE_CONFIG_DIR: path },
          stripAuthEnv: true,
          isolatedCredentials: true,
          accountId,
          provenance: `managed:${accountId}`
        }
      })
    )
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
    const account = this.getActiveAccount(settings.claudeManagedAccounts, this.lastSyncedAccountId)
    if (account && hasIsolatedClaudeAccountAuth(account.managedAuthPath)) {
      this.lastSyncedAccountId = null
    }
  }

  private async safeSyncForCurrentSelection(): Promise<void> {
    try {
      await this.syncForCurrentSelection()
    } catch (error) {
      console.warn('[claude-runtime-auth] Failed to sync runtime auth state:', error)
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
