import type { Store } from '../persistence'
import {
  getSelectedClaudeAccountIdForTarget,
  normalizeClaudeAccountSelectionTarget,
  type ClaudeAccountSelectionTarget
} from './runtime-selection'
import { countClaudePinnedAccountUsers } from './claude-pinned-pty-registry'
import { ClaudeRuntimeAuthSync } from './runtime-auth/runtime-auth-sync'
import type {
  ClaudeLaunchAuthOptions,
  ClaudeRuntimeAuthPreparation
} from './runtime-auth/runtime-auth-types'

export type {
  ClaudeLaunchAuthOptions,
  ClaudeRuntimeAuthPreparation
} from './runtime-auth/runtime-auth-types'

export class ClaudeRuntimeAuthService extends ClaudeRuntimeAuthSync {
  constructor(store: Store) {
    super(store)
    this.initializeLastSyncedState()
    void this.safeSyncForCurrentSelection()
  }

  async prepareForClaudeLaunch(
    target?: ClaudeAccountSelectionTarget,
    options?: ClaudeLaunchAuthOptions
  ): Promise<ClaudeRuntimeAuthPreparation> {
    const effectiveTarget = target ?? this.getDefaultAccountSelectionTarget()
    const accountId = options?.accountId
    if (accountId) {
      return this.serializeMutation(() =>
        this.prepareRequestedAccountLaunch(accountId, effectiveTarget)
      )
    }
    await this.syncForCurrentSelection(effectiveTarget)
    return this.getPreparation(effectiveTarget)
  }

  /** Reads back a drained pinned account's Keychain copy; a no-op off macOS or without a seed. */
  async reconcilePinnedAccountCredentials(accountId: string): Promise<void> {
    await this.serializeMutation(async () => {
      const account = this.getActiveAccount(
        this.store.getSettings().claudeManagedAccounts,
        accountId
      )
      if (
        process.platform !== 'darwin' ||
        !account ||
        countClaudePinnedAccountUsers(accountId) > 0
      ) {
        return
      }
      const configDir = await this.getOwnedManagedAuthPath(account)
      if (configDir) {
        await this.reconcilePinnedKeychainCredentials(account, configDir, { strict: false })
      }
    })
  }

  async prepareForRateLimitFetch(
    target?: ClaudeAccountSelectionTarget
  ): Promise<ClaudeRuntimeAuthPreparation> {
    const effectiveTarget = target ?? this.getDefaultAccountSelectionTarget()
    await this.syncForCurrentSelection(effectiveTarget)
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

  // Why one mutation: selection updates settings before it queues its sync, so reading the active
  // account here, in the queue, can never pin an account a concurrent switch just activated.
  private async prepareRequestedAccountLaunch(
    accountId: string,
    target: ClaudeAccountSelectionTarget
  ): Promise<ClaudeRuntimeAuthPreparation> {
    const settings = this.store.getSettings()
    const account = this.getActiveAccount(settings.claudeManagedAccounts, accountId)
    if (!account) {
      throw new Error('That Claude account no longer exists. Run `orca account list` and retry.')
    }
    if (
      normalizeClaudeAccountSelectionTarget(target).runtime === 'host' &&
      getSelectedClaudeAccountIdForTarget(settings, { runtime: 'host' }) === accountId
    ) {
      // Why: the active account already owns ~/.claude; pinning it too would put one refresh
      // token in two stores.
      await this.doSyncForCurrentSelection(target)
      return this.getPreparation(target)
    }
    return this.preparePinnedClaudeLaunch(account.id, target)
  }

  private initializeLastSyncedState(): void {
    const settings = this.store.getSettings()
    this.lastSyncedAccountId = getSelectedClaudeAccountIdForTarget(settings, { runtime: 'host' })
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
