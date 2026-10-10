import { getAppEnvironment } from '../../shared/app-environment'
import { claudeProfileRoutingEnabled } from '../../shared/claude-profile-routing'
import { ClaudeProfileRouter } from './claude-profile-router'
import { ClaudeWslProfileRouter } from './claude-profile-wsl-router'
import {
  getClaudeProfileRouter,
  installClaudeProfileRouter
} from './claude-profile-installed-router'
import type { Store } from '../persistence'
import {
  getSelectedClaudeAccountIdForTarget,
  type ClaudeAccountSelectionTarget
} from './runtime-selection'
import { ClaudeRuntimeAuthSync } from './runtime-auth/runtime-auth-sync'
import type { ClaudeRuntimeAuthPreparation } from './runtime-auth/runtime-auth-types'

export type { ClaudeRuntimeAuthPreparation } from './runtime-auth/runtime-auth-types'

function routerFor(target: ClaudeAccountSelectionTarget): ClaudeProfileRouter | undefined {
  return target.runtime === 'wsl' ? undefined : getClaudeProfileRouter()
}

export class ClaudeRuntimeAuthService extends ClaudeRuntimeAuthSync {
  private readonly wslRouter?: ClaudeWslProfileRouter

  constructor(store: Store) {
    super(store)
    if (claudeProfileRoutingEnabled()) {
      const args = {
        getSettings: () => store.getSettings(),
        dataRoot: getAppEnvironment().getPath('userData')
      }
      installClaudeProfileRouter(new ClaudeProfileRouter(args))
      this.wslRouter = process.platform === 'win32' ? new ClaudeWslProfileRouter(args) : undefined
    }
    this.initializeLastSyncedState()
    void this.safeSyncForCurrentSelection()
  }

  async prepareForClaudeLaunch(
    target?: ClaudeAccountSelectionTarget
  ): Promise<ClaudeRuntimeAuthPreparation> {
    const effectiveTarget = target ?? this.getDefaultAccountSelectionTarget()
    const wsl = this.wslRouteFor(effectiveTarget)
    if (wsl) {
      return wsl.router.prepareLaunch(wsl.distro)
    }
    const router = routerFor(effectiveTarget)
    if (router) {
      return router.prepareLaunch()
    }
    await this.syncForCurrentSelection(effectiveTarget)
    return this.getPreparation(effectiveTarget)
  }

  async prepareForRateLimitFetch(
    target?: ClaudeAccountSelectionTarget
  ): Promise<ClaudeRuntimeAuthPreparation> {
    const effectiveTarget = target ?? this.getDefaultAccountSelectionTarget()
    const wsl = this.wslRouteFor(effectiveTarget)
    if (wsl) {
      return wsl.router.preparation(wsl.distro)
    }
    const router = routerFor(effectiveTarget)
    if (router) {
      return router.preparation()
    }
    await this.syncForCurrentSelection(effectiveTarget)
    return this.getPreparation(effectiveTarget)
  }

  async syncForCurrentSelection(target?: ClaudeAccountSelectionTarget): Promise<void> {
    await this.serializeMutation(async () => {
      const effectiveTarget = target ?? this.getDefaultAccountSelectionTarget()
      const wsl = this.wslRouteFor(effectiveTarget)
      const router = routerFor(effectiveTarget)
      if (wsl) {
        await this.publishWsl(wsl.router, wsl.distro)
      } else if (router) {
        router.publish()
      } else {
        await this.doSyncForCurrentSelection(effectiveTarget)
      }
    })
  }

  /** Null when the target is not a WSL distro routed by account folders. */
  private wslRouteFor(
    target: ClaudeAccountSelectionTarget
  ): { router: ClaudeWslProfileRouter; distro: string } | null {
    const distro =
      target.runtime === 'wsl' ? this.resolveWslDefaultTarget(target).wslDistro?.trim() : null
    return this.wslRouter && distro ? { router: this.wslRouter, distro } : null
  }

  // Why never thrown: a guest Orca cannot reach also cannot run a pane, and a deleted distro must
  // not block removing its accounts. The next select, or a start while it runs, rewrites it.
  private async publishWsl(router: ClaudeWslProfileRouter, distro: string): Promise<void> {
    await router.publish(distro).catch((error: unknown) => {
      console.warn(`[claude-profile] Could not update the Claude account in WSL ${distro}:`, error)
    })
  }

  /** Startup and rollback republish only running distros: neither may boot a stopped one. */
  private async publishRunningWslDistros(): Promise<void> {
    const router = this.wslRouter
    if (router) {
      const distros = await router.runningDistros()
      await Promise.all(distros.map((distro) => this.publishWsl(router, distro)))
    }
  }

  async forceMaterializeCurrentSelectionForRollback(): Promise<void> {
    await this.serializeMutation(async () => {
      const router = getClaudeProfileRouter()
      if (router) {
        router.publish()
        await this.publishRunningWslDistros()
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
    return this.getPreparation(target).configDir
  }

  private initializeLastSyncedState(): void {
    const settings = this.store.getSettings()
    this.lastSyncedAccountId = getSelectedClaudeAccountIdForTarget(settings, { runtime: 'host' })
  }

  private async safeSyncForCurrentSelection(): Promise<void> {
    try {
      const router = getClaudeProfileRouter()
      if (!router) {
        await this.syncForCurrentSelection()
        return
      }
      // Why serialized: an account change during startup must not be overwritten by this older read.
      await this.serializeMutation(async () => {
        router.publish()
        await this.publishRunningWslDistros()
      })
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
