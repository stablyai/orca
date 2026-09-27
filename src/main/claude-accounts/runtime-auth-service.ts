import { parseWslUncPath } from '../../shared/wsl-paths'
import type { ClaudeUsageScanTarget } from '../claude-usage/scanner'
import type { Store } from '../persistence'
import { getInitialClaudeRateLimitTarget } from '../rate-limits/claude-rate-limit-target'
import { getDefaultWslDistro, getWslHome, toWindowsWslPath } from '../wsl'
import { getWslGuestEnvironment } from '../wsl/wsl-guest-environment'
import {
  getSelectedClaudeAccountIdForTarget,
  normalizeClaudeAccountSelectionTarget,
  type ClaudeAccountSelectionTarget
} from './runtime-selection'
import { ClaudeRuntimeAuthSync } from './runtime-auth/runtime-auth-sync'
import type { ClaudeRuntimeAuthPreparation } from './runtime-auth/runtime-auth-types'

export type { ClaudeRuntimeAuthPreparation } from './runtime-auth/runtime-auth-types'

export class ClaudeRuntimeAuthService extends ClaudeRuntimeAuthSync {
  constructor(store: Store) {
    super(store)
    this.initializeLastSyncedState()
    void this.safeSyncForCurrentSelection()
  }

  async prepareForClaudeLaunch(
    target?: ClaudeAccountSelectionTarget
  ): Promise<ClaudeRuntimeAuthPreparation> {
    const effectiveTarget = target ?? this.getDefaultAccountSelectionTarget()
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

  async getUsageScanTarget(): Promise<ClaudeUsageScanTarget> {
    const settings = this.store.getSettings()
    const target = this.resolveWslDefaultTarget(getInitialClaudeRateLimitTarget(settings))
    const normalizedTarget = normalizeClaudeAccountSelectionTarget(target)
    if (normalizedTarget.runtime !== 'wsl') {
      return { configDir: this.pathResolver.getRuntimePaths().configDir, includeWslHomes: true }
    }

    const activeAccountId = getSelectedClaudeAccountIdForTarget(settings, normalizedTarget)
    const activeAccount = this.getActiveAccount(settings.claudeManagedAccounts, activeAccountId)
    const distro = normalizedTarget.wslDistro ?? getDefaultWslDistro()
    if (activeAccount?.managedAuthRuntime === 'wsl' && activeAccount.wslLinuxAuthPath && distro) {
      return { configDir: toWindowsWslPath(activeAccount.wslLinuxAuthPath, distro) }
    }

    const environment = distro ? await getWslGuestEnvironment(distro) : null
    const wslHome = distro ? getWslHome(distro) : null
    const wslHomeInfo = wslHome ? parseWslUncPath(wslHome) : null
    const linuxConfigDir =
      environment?.claudeConfigDir ??
      (wslHomeInfo ? `${wslHomeInfo.linuxPath.replace(/\/$/, '')}/.claude` : null)
    if (!distro || !linuxConfigDir) {
      throw new Error('Selected WSL Claude runtime is unavailable')
    }
    return {
      configDir: toWindowsWslPath(linuxConfigDir, distro),
      includeWslHomes: false
    }
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
