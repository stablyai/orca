import { homedir } from 'node:os'
import { resolveClaudeCommand } from '../codex-cli/command'
import { getAppEnvironment } from '../../shared/app-environment'
import { claudeProfileRoutingEnabled } from '../../shared/claude-profile-routing'
import {
  createNativeClaudeProfileRouting,
  systemDefaultClaudeHome
} from './claude-profile-native-owner'
import {
  installClaudeProfileRoutingAuthority,
  getClaudeProfileRoutingAuthority
} from './claude-profile-routing-authority'
import { probeClaudeCliVersionCached } from '../claude/claude-hook-event-versions'
import type { Store } from '../persistence'
import {
  getSelectedClaudeAccountIdForTarget,
  type ClaudeAccountSelectionTarget
} from './runtime-selection'
import { ClaudeRuntimeAuthSync } from './runtime-auth/runtime-auth-sync'
import type { ClaudeRuntimeAuthPreparation } from './runtime-auth/runtime-auth-types'

export type { ClaudeRuntimeAuthPreparation } from './runtime-auth/runtime-auth-types'

export class ClaudeRuntimeAuthService extends ClaudeRuntimeAuthSync {
  constructor(store: Store) {
    super(store)
    if (claudeProfileRoutingEnabled()) {
      installClaudeProfileRoutingAuthority(
        createNativeClaudeProfileRouting({
          store,
          dataRoot: getAppEnvironment().getPath('userData'),
          userHome: homedir(),
          defaultHome: () => systemDefaultClaudeHome(process.env, homedir()),
          claudeVersion: () => probeClaudeCliVersionCached(resolveClaudeCommand())
        })
      )
    }
    this.initializeLastSyncedState()
    void this.safeSyncForCurrentSelection()
  }

  async prepareForClaudeLaunch(
    target?: ClaudeAccountSelectionTarget
  ): Promise<ClaudeRuntimeAuthPreparation> {
    const effectiveTarget = target ?? this.getDefaultAccountSelectionTarget()
    const profiles = getClaudeProfileRoutingAuthority()
    if (profiles) {
      return profiles.prepare(effectiveTarget)
    }
    await this.syncForCurrentSelection(effectiveTarget)
    return this.getPreparation(effectiveTarget)
  }

  async prepareForRateLimitFetch(
    target?: ClaudeAccountSelectionTarget
  ): Promise<ClaudeRuntimeAuthPreparation> {
    const profiles = getClaudeProfileRoutingAuthority()
    if (profiles) {
      return profiles.preparation(profiles.resolve(target))
    }
    const effectiveTarget = target ?? this.getDefaultAccountSelectionTarget()
    await this.syncForCurrentSelection(effectiveTarget)
    return this.getPreparation(effectiveTarget)
  }

  async syncForCurrentSelection(target?: ClaudeAccountSelectionTarget): Promise<void> {
    await this.serializeMutation(async () => {
      const effectiveTarget = target ?? this.getDefaultAccountSelectionTarget()
      const profiles = getClaudeProfileRoutingAuthority()
      await (profiles
        ? profiles.publish(effectiveTarget)
        : this.doSyncForCurrentSelection(effectiveTarget))
    })
  }

  async forceMaterializeCurrentSelectionForRollback(): Promise<void> {
    await this.serializeMutation(async () => {
      const profiles = getClaudeProfileRoutingAuthority()
      if (profiles) {
        await profiles.startup()
        return
      }
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
    const legacy = () => this.getPreparation(target).configDir
    return getClaudeProfileRoutingAuthority()?.configDirOr(target, legacy) ?? legacy()
  }

  private initializeLastSyncedState(): void {
    const settings = this.store.getSettings()
    this.lastSyncedAccountId = getSelectedClaudeAccountIdForTarget(settings, { runtime: 'host' })
  }

  private async safeSyncForCurrentSelection(): Promise<void> {
    try {
      const profiles = getClaudeProfileRoutingAuthority()
      await (profiles ? profiles.startup() : this.syncForCurrentSelection())
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
