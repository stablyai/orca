import type { Store } from '../persistence'
import {
  getSelectedClaudeAccountIdForTarget,
  normalizeClaudeAccountSelectionTarget,
  type ClaudeAccountSelectionTarget
} from './runtime-selection'
import {
  countClaudePinnedAccountUsers,
  releaseClaudePinnedAccountReservation
} from './claude-pinned-pty-registry'
import {
  clearPendingPinnedClaudeSeed,
  listPendingPinnedClaudeSeedAccountIds,
  readPinnedClaudeSeedMarker
} from './claude-pinned-credentials'
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
      return this.prepareRequestedAccountLaunch(accountId, effectiveTarget)
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

  /**
   * An `--account` launch. The pinned reservation (and any wait for a usage fetch holding the
   * account) happens before the auth queue, so a background fetch never stalls every other launch
   * and sync; the queued part then re-validates against settings that no switch can race, since
   * the claims make a host mutation and a reservation mutually exclusive.
   */
  private async prepareRequestedAccountLaunch(
    accountId: string,
    target: ClaudeAccountSelectionTarget
  ): Promise<ClaudeRuntimeAuthPreparation> {
    this.requireClaudeAccountForLaunch(accountId)
    if (this.isActiveHostAccountLaunch(accountId, target)) {
      return this.serializeMutation(async () => {
        if (!this.isActiveHostAccountLaunch(accountId, target)) {
          throw new Error('The active Claude account changed during this launch. Retry the launch.')
        }
        // Why: the active account already owns ~/.claude; pinning it too would put one refresh
        // token in two stores.
        await this.doSyncForCurrentSelection(target)
        return this.getPreparation(target)
      })
    }
    if (normalizeClaudeAccountSelectionTarget(target).runtime !== 'host') {
      throw new Error('Claude --account launches are not supported for WSL terminals yet.')
    }
    const sharedWithLiveSession = await this.reservePinnedClaudeAccount(accountId)
    // Why no host-mutation re-check in the queue: while the reservation is held, no switch or
    // removal can claim the account, so only settings changes made during the wait remain.
    try {
      return await this.serializeMutation(() =>
        this.preparePinnedClaudeLaunch(accountId, sharedWithLiveSession)
      )
    } catch (error) {
      releaseClaudePinnedAccountReservation(accountId)
      throw error
    }
  }

  private isActiveHostAccountLaunch(
    accountId: string,
    target: ClaudeAccountSelectionTarget
  ): boolean {
    return (
      normalizeClaudeAccountSelectionTarget(target).runtime === 'host' &&
      getSelectedClaudeAccountIdForTarget(this.store.getSettings(), { runtime: 'host' }) ===
        accountId
    )
  }

  /**
   * Startup pass over the seed markers found by the raw-path scan: drops flags whose dir is not
   * Orca-owned or has no marker (they would suppress refresh until restart), and reads back
   * crashed pinned sessions no surviving PTY still holds.
   */
  async revalidatePinnedSeedMarkers(): Promise<void> {
    await this.serializeMutation(async () => {
      const accounts = this.store.getSettings().claudeManagedAccounts
      for (const accountId of listPendingPinnedClaudeSeedAccountIds()) {
        const account = this.getActiveAccount(accounts, accountId)
        const configDir =
          account && account.managedAuthRuntime !== 'wsl'
            ? await this.getOwnedManagedAuthPath(account)
            : null
        if (!account || !configDir || readPinnedClaudeSeedMarker(configDir) === null) {
          clearPendingPinnedClaudeSeed(accountId)
        } else if (countClaudePinnedAccountUsers(accountId) === 0) {
          await this.reconcilePinnedKeychainCredentials(account, configDir, { strict: false })
        }
      }
    })
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
