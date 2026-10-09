import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { toWindowsWslPath } from '../../shared/wsl-paths'
import { resolveLocalAccountRuntimeTarget } from '../../shared/local-account-runtime'
import type { Store } from '../persistence'
import { getDefaultWslDistro, getWslHome } from '../wsl'
import { ClaudeProfileRouter } from './claude-profile-router'
import { ClaudeWslProfileRouter } from './claude-profile-wsl-router'
import {
  installClaudeProfileRouter,
  installClaudeWslProfileRouter
} from './claude-profile-installed-router'
import type { ClaudeAccountSelectionTarget } from './runtime-selection'
import type { ClaudeRuntimeAuthPreparation } from './runtime-auth/runtime-auth-types'

export type { ClaudeRuntimeAuthPreparation } from './runtime-auth/runtime-auth-types'

/** `configDir` is the CLAUDE_CONFIG_DIR value; `readPath` is where this host reads it (UNC for WSL). */
export type ClaudeAccountFolder = { configDir: string; readPath: string }

/** Routes Claude launches on this host and its WSL distros to the selected account folder. */
export class ClaudeRuntimeAuthService {
  readonly router: ClaudeProfileRouter
  private readonly wslRouter?: ClaudeWslProfileRouter
  private readonly dataRoot = getAppEnvironment().getPath('userData')
  private mutationQueue: Promise<unknown> = Promise.resolve()

  constructor(private readonly store: Pick<Store, 'getSettings'>) {
    const args = { getSettings: () => store.getSettings(), dataRoot: this.dataRoot }
    this.router = new ClaudeProfileRouter(args)
    installClaudeProfileRouter(this.router)
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
    try {
      return await (wsl ? wsl.router.preparation(wsl.distro) : this.router.preparation())
    } catch (error) {
      // Why not thrown: one usage cycle polls every provider, so one account must not stop it.
      return {
        configDir: '',
        envPatch: {},
        provenance: 'profile:unavailable',
        usageError: error instanceof Error ? error.message : String(error)
      }
    }
  }

  /** Rewrites the which-account file for `target` after its selection changed. */
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

  /** Startup and rollback republish only running distros: neither may boot a stopped one. */
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

  /** Creates and sets up an account's folder so Claude can sign in to it. */
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
    // Why never thrown: a deleted distro must not block removing its accounts.
    await wsl.router.removeAccount(wsl.distro, accountId).catch((error: unknown) => {
      console.warn(
        `[claude-profile] Could not delete the Claude account folder in WSL ${wsl.distro}:`,
        error
      )
    })
  }

  /** System default's folder: skills and plugins install there and are linked into accounts. */
  getRuntimeConfigDir(target?: ClaudeAccountSelectionTarget): string {
    const effective = this.resolveTarget(target)
    const home =
      effective.runtime === 'wsl' && effective.wslDistro ? getWslHome(effective.wslDistro) : null
    return home ? join(home, '.claude') : this.router.systemDefaultHome()
  }

  // Why never thrown: a guest Orca cannot reach also cannot run a pane, and a deleted distro must
  // not block removing its accounts. The next select, or a start while it runs, rewrites it.
  private async publishWsl(router: ClaudeWslProfileRouter, distro: string): Promise<void> {
    await router.publish(distro).catch((error: unknown) => {
      console.warn(`[claude-profile] Could not update the Claude account in WSL ${distro}:`, error)
    })
  }

  /** Null when the target is not a WSL distro this host can route. */
  private wslRouteFor(
    target?: ClaudeAccountSelectionTarget
  ): { router: ClaudeWslProfileRouter; distro: string } | null {
    const effective = this.resolveTarget(target)
    const distro = effective.runtime === 'wsl' ? effective.wslDistro?.trim() : null
    return this.wslRouter && distro ? { router: this.wslRouter, distro } : null
  }

  /** A WSL target that names no distro means the default distro, as Claude launches it there. */
  private resolveTarget(target?: ClaudeAccountSelectionTarget): ClaudeAccountSelectionTarget {
    const effective =
      target ??
      // Why: stale cross-platform WSL pins must stay on the host off Windows.
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
