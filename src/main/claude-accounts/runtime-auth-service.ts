import { createWslClaudeProfileOwner } from './claude-profile-wsl-owner'
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
import type { ClaudeProfileHostAccess } from './claude-profile-routing-owner'
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
          wsl:
            process.platform === 'win32'
              ? createWslClaudeProfileOwner(() => store.getSettings())
              : undefined,
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
      // Why: an unrouted WSL distro launches System Default with no guest call, as before profiles.
      return profiles.routes(effectiveTarget)
        ? profiles.prepare(effectiveTarget)
        : this.getPreparation(effectiveTarget)
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

  /** `access: 'boot'` marks a user's select or remove, which may start a stopped WSL distro. */
  async syncForCurrentSelection(
    target?: ClaudeAccountSelectionTarget,
    access: ClaudeProfileHostAccess = 'if-running'
  ): Promise<void> {
    await this.serializeMutation(async () => {
      const effectiveTarget = target ?? this.getDefaultAccountSelectionTarget()
      const profiles = getClaudeProfileRoutingAuthority()
      if (!profiles) {
        await this.doSyncForCurrentSelection(effectiveTarget)
      } else if (profiles.routes(effectiveTarget)) {
        await profiles.publish(effectiveTarget, 'always', access)
      } else {
        await profiles.retire(effectiveTarget, access)
      }
    })
  }

  /** With profiles, `target` limits the republish to the target whose change failed. */
  async forceMaterializeCurrentSelectionForRollback(
    target?: ClaudeAccountSelectionTarget
  ): Promise<void> {
    await this.serializeMutation(async () => {
      const profiles = getClaudeProfileRoutingAuthority()
      if (profiles) {
        if (!target) {
          await profiles.startup()
        } else if (profiles.routes(target)) {
          // Why boot: this undoes a user's failed select or remove.
          await profiles.publish(target, 'always', 'boot')
        }
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
