import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { toWindowsWslPath } from '../../shared/wsl-paths'
import { resolveLocalAccountRuntimeTarget } from '../../shared/local-account-runtime'
import type { Store } from '../persistence'
import { isWslDistroRunning } from '../wsl-background-distro-gate'
import { getDefaultWslDistro, getWslHome } from '../wsl'
import { ClaudeProfileRouter } from './claude-profile-router'
import { ClaudeWslProfileRouter } from './claude-profile-wsl-router'
import {
  installClaudeObservedConfigDirs,
  installClaudeProfileRouter,
  installClaudeWslProfileRouter
} from './claude-profile-installed-router'
import { ClaudeObservedConfigDirs } from './claude-observed-config-dirs'
import type { ClaudeAccountSelectionTarget } from './runtime-selection'
import type { ClaudeRuntimeAuthPreparation } from './runtime-auth/runtime-auth-types'

export type { ClaudeRuntimeAuthPreparation } from './runtime-auth/runtime-auth-types'

/** `readPath` exposes a guest configDir to the host through UNC on WSL. */
export type ClaudeAccountFolder = { configDir: string; readPath: string }

export class ClaudeRuntimeAuthService {
  readonly router: ClaudeProfileRouter
  private readonly wslRouter?: ClaudeWslProfileRouter
  private readonly dataRoot = getAppEnvironment().getPath('userData')
  private mutationQueue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly store: Pick<Store, 'getSettings'>,
    private readonly isDistroRunning: (distro: string) => Promise<boolean> = isWslDistroRunning
  ) {
    const args = { getSettings: () => store.getSettings(), dataRoot: this.dataRoot }
    this.router = new ClaudeProfileRouter(args)
    installClaudeProfileRouter(this.router)
    installClaudeObservedConfigDirs(
      new ClaudeObservedConfigDirs(join(this.dataRoot, 'claude-observed-config-dirs.json'), () =>
        store.getSettings()
      )
    )
    this.wslRouter = process.platform === 'win32' ? new ClaudeWslProfileRouter(args) : undefined
    installClaudeWslProfileRouter(this.wslRouter)
    void this.publishAll().catch((error: unknown) => {
      console.warn('[claude-runtime-auth] Failed to publish the Claude account selection:', error)
    })
  }

  prepareForClaudeLaunch(
    target?: ClaudeAccountSelectionTarget
  ): Promise<ClaudeRuntimeAuthPreparation> {
    const wsl = this.wslRouteFor(target)
    return wsl ? wsl.router.prepareLaunch(wsl.distro) : this.router.prepareLaunch()
  }

  async prepareForRateLimitFetch(
    target?: ClaudeAccountSelectionTarget
  ): Promise<ClaudeRuntimeAuthPreparation> {
    const wsl = this.wslRouteFor(target)
    // Background quota polls must not boot stopped distros.
    if (wsl && !(await this.isDistroRunning(wsl.distro))) {
      return {
        configDir: '',
        envPatch: {},
        provenance: 'profile:unavailable',
        usageError: `WSL distro ${wsl.distro} is not running.`
      }
    }
    try {
      return await (wsl ? wsl.router.preparation(wsl.distro) : this.router.preparation())
    } catch (error) {
      // An unavailable account must not interrupt polling other providers.
      return {
        configDir: '',
        envPatch: {},
        provenance: 'profile:unavailable',
        usageError: error instanceof Error ? error.message : String(error)
      }
    }
  }

  async syncForCurrentSelection(target?: ClaudeAccountSelectionTarget): Promise<void> {
    await this.serializeMutation(async () => {
      const wsl = this.wslRouteFor(target)
      if (wsl) {
        await this.publishWsl(wsl.router, wsl.distro)
      } else {
        this.router.publish()
      }
    })
  }

  /** Startup and rollback must not boot stopped distros. */
  async publishAll(): Promise<void> {
    await this.serializeMutation(async () => {
      this.router.publish()
      const router = this.wslRouter
      if (router) {
        const distros = await router.runningDistros()
        await Promise.all(distros.map((distro) => this.publishWsl(router, distro)))
      }
    })
  }

  async prepareAccountFolder(
    accountId: string,
    target: ClaudeAccountSelectionTarget
  ): Promise<ClaudeAccountFolder> {
    const wsl = this.wslRouteFor(target)
    if (!wsl) {
      const home = await this.router.prepareAccount(accountId)
      return { configDir: home, readPath: home }
    }
    const home = await wsl.router.prepareAccount(wsl.distro, accountId)
    return { configDir: home, readPath: toWindowsWslPath(home, wsl.distro) }
  }

  async removeAccountFolder(
    accountId: string,
    target: ClaudeAccountSelectionTarget
  ): Promise<void> {
    const wsl = this.wslRouteFor(target)
    if (!wsl) {
      await this.router.removeAccount(accountId)
      return
    }
    // Deleted distros must not block account removal.
    await wsl.router.removeAccount(wsl.distro, accountId).catch((error: unknown) => {
      console.warn(
        `[claude-profile] Could not delete the Claude account folder in WSL ${wsl.distro}:`,
        error
      )
    })
  }

  /** Install skills and plugins in System default so accounts can share them. */
  getRuntimeConfigDir(target?: ClaudeAccountSelectionTarget): string {
    const effective = this.resolveTarget(target)
    const home =
      effective.runtime === 'wsl' && effective.wslDistro ? getWslHome(effective.wslDistro) : null
    return home ? join(home, '.claude') : this.router.systemDefaultHome()
  }

  // Guest failures must not block account removal; a later selection or startup retries publication.
  private async publishWsl(router: ClaudeWslProfileRouter, distro: string): Promise<void> {
    await router.publish(distro).catch((error: unknown) => {
      console.warn(`[claude-profile] Could not update the Claude account in WSL ${distro}:`, error)
    })
  }

  private wslRouteFor(
    target?: ClaudeAccountSelectionTarget
  ): { router: ClaudeWslProfileRouter; distro: string } | null {
    const effective = this.resolveTarget(target)
    const distro = effective.runtime === 'wsl' ? effective.wslDistro?.trim() : null
    return this.wslRouter && distro ? { router: this.wslRouter, distro } : null
  }

  /** An unspecified WSL distro uses the default, matching Claude launches. */
  private resolveTarget(target?: ClaudeAccountSelectionTarget): ClaudeAccountSelectionTarget {
    const effective =
      target ??
      // Ignore stale cross-platform WSL pins outside Windows.
      (process.platform === 'win32'
        ? resolveLocalAccountRuntimeTarget(this.store.getSettings())
        : { runtime: 'host' as const })
    if (effective.runtime !== 'wsl' || effective.wslDistro?.trim()) {
      return effective
    }
    const defaultDistro = getDefaultWslDistro()
    return defaultDistro ? { runtime: 'wsl', wslDistro: defaultDistro } : effective
  }

  private serializeMutation<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(fn, fn)
    this.mutationQueue = next.catch(() => {})
    return next
  }
}
