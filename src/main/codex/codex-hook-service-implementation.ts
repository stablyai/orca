import { win32 as pathWin32 } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { dedupeInFlightRun } from '../in-flight-run-dedupe'
import { refreshManagedScriptIfPresent } from '../agent-hooks/managed-hook-script-refresh'
import { getOrcaManagedCodexHomePath } from './codex-home-paths'
import { getManagedScriptPath } from './codex-hook-definition'
import { installCodexHooksExclusively } from './codex-hook-local-install'
import {
  refreshCodexRuntimeUserHooksExclusively,
  removeCodexHooksExclusively
} from './codex-hook-local-maintenance'
import { installCodexHooksRemote } from './codex-hook-remote-install'
import { getManagedScript } from './codex-hook-script'
import { getCodexHookStatusAfterInstall } from './codex-hook-status'
import { removeStaleWslRuntimeManagedHookTrustEntries } from './codex-hook-trust-cleanup'
import { runExclusivelyForRuntimeAndSystemTrustConfig } from './codex-hook-trust-queue'
import {
  getWslHookReconciliationAction,
  getWslReconciliationKey,
  installManagedHooksIntoWslRuntime,
  refreshWslRuntimeUserHooks
} from './codex-hook-wsl-runtime'
import {
  createCodexWslRuntimeHookInstallPlan,
  type CodexWslRuntimeHookTarget,
  type WslCanonicalPathSettlement
} from './codex-wsl-hook-install-plan'
import type { CodexTrustEntry } from './config-toml-trust'

/** Lane-scoped so the hooks-on install never joins the hooks-off refresh. */
function launchPrepKey(lane: 'install' | 'refresh', runtimeHomePath: string): string {
  return `${lane}\0${normalizeRuntimePathForComparison(runtimeHomePath)}`
}

export class CodexHookService {
  async refreshManagedScripts(): Promise<void> {
    await refreshManagedScriptIfPresent(getManagedScriptPath(), getManagedScript())
  }

  private readonly wslReconciliationGeneration = new Map<string, number>()
  private readonly wslInstallsInFlight = new Map<string, Promise<AgentHookInstallStatus | null>>()
  private readonly launchPrepInFlight = new Map<string, Promise<AgentHookInstallStatus>>()

  private supersedeWslReconciliation(runtimeHomePath: string | null | undefined): number {
    if (!runtimeHomePath) {
      return 0
    }
    const key = getWslReconciliationKey(runtimeHomePath)
    const generation = (this.wslReconciliationGeneration.get(key) ?? 0) + 1
    this.wslReconciliationGeneration.set(key, generation)
    return generation
  }

  async installForRuntimeHome(
    runtimeHomePath: string | null | undefined,
    target?: CodexWslRuntimeHookTarget
  ): Promise<AgentHookInstallStatus | null> {
    const generation = this.supersedeWslReconciliation(runtimeHomePath)
    let installedTrustConfigPath: string | null = null
    let installSucceeded = false
    // Why: the install below now awaits a codex app-server session, so a
    // settlement callback can land mid-install. This gate keeps reconciliation
    // reading the finished install's flags, as it did when the install was
    // synchronous and no callback could interleave with it.
    let markPrimaryInstallSettled!: () => void
    let reconciliationChain = new Promise<void>((resolve) => {
      markPrimaryInstallSettled = resolve
    })
    const reconcileSettledWslCanonicalPath = async (
      settlement: WslCanonicalPathSettlement
    ): Promise<void> => {
      if (!runtimeHomePath) {
        return
      }
      const key = getWslReconciliationKey(runtimeHomePath)
      const resolvedPlan =
        settlement.status === 'resolved'
          ? createCodexWslRuntimeHookInstallPlan(
              runtimeHomePath,
              target,
              () => settlement.canonicalPath
            )
          : null
      const action = getWslHookReconciliationAction({
        settlement,
        isCurrentGeneration: this.wslReconciliationGeneration.get(key) === generation,
        installedTrustConfigPath,
        resolvedTrustConfigPath: resolvedPlan?.trustConfigPath ?? null,
        installSucceeded
      })
      if (action === 'none') {
        return
      }
      if (action === 'remove') {
        try {
          removeStaleWslRuntimeManagedHookTrustEntries(
            pathWin32.join(runtimeHomePath, 'config.toml'),
            []
          )
        } catch (error) {
          console.warn('[codex-hook-service] failed to revoke stale WSL hook trust', error)
        }
        return
      }
      if (!resolvedPlan) {
        return
      }
      const status = await installManagedHooksIntoWslRuntime(resolvedPlan)
      if (status.state === 'error') {
        console.warn('[codex-hook-service] failed to reconcile WSL hook path', status.detail)
        return
      }
      installedTrustConfigPath = resolvedPlan.trustConfigPath
      installSucceeded = status.state === 'installed'
    }
    const onCanonicalPathSettled = (settlement: WslCanonicalPathSettlement): void => {
      const run = (): Promise<void> => reconcileSettledWslCanonicalPath(settlement)
      reconciliationChain = reconciliationChain.then(run, run)
      void reconciliationChain.catch((error: unknown) => {
        console.warn('[codex-hook-service] failed to reconcile WSL hook path', error)
      })
    }
    const wslPlan = createCodexWslRuntimeHookInstallPlan(
      runtimeHomePath,
      target,
      undefined,
      onCanonicalPathSettled
    )
    installedTrustConfigPath = wslPlan?.trustConfigPath ?? null
    try {
      const status = wslPlan ? await installManagedHooksIntoWslRuntime(wslPlan) : null
      installSucceeded = status?.state === 'installed'
      return status
    } finally {
      markPrimaryInstallSettled()
    }
  }

  installForRuntimeHomeSerialized(
    runtimeHomePath: string | null | undefined,
    target?: CodexWslRuntimeHookTarget
  ): Promise<AgentHookInstallStatus | null> {
    if (!runtimeHomePath) {
      return Promise.resolve(null)
    }
    const targetKey = target?.runtime === 'wsl' ? target.wslDistro?.trim().toLowerCase() : ''
    return dedupeInFlightRun(
      this.wslInstallsInFlight,
      `${getWslReconciliationKey(runtimeHomePath)}\0${targetKey ?? ''}`,
      () => this.installForRuntimeHome(runtimeHomePath, target)
    )
  }

  async prepareRuntimeHomeForLaunch(
    runtimeHomePath: string | null | undefined,
    target: CodexWslRuntimeHookTarget | undefined,
    hooksEnabled: boolean
  ): Promise<AgentHookInstallStatus> {
    if (hooksEnabled) {
      // Why: a managed account's launch home is its self-contained CODEX_HOME,
      // so hooks/trust must install there rather than the shared mirror.
      return (
        (await this.installForRuntimeHomeSerialized(runtimeHomePath, target)) ??
        (await this.installForLaunchPrep(runtimeHomePath ?? undefined))
      )
    }
    return (
      this.refreshRuntimeUserHooksForRuntimeHome(runtimeHomePath, target) ??
      (await this.refreshRuntimeUserHooksForLaunchPrep(runtimeHomePath ?? undefined))
    )
  }

  refreshRuntimeUserHooksForRuntimeHome(
    runtimeHomePath: string | null | undefined,
    target?: CodexWslRuntimeHookTarget
  ): AgentHookInstallStatus | null {
    this.supersedeWslReconciliation(runtimeHomePath)
    const wslPlan = createCodexWslRuntimeHookInstallPlan(runtimeHomePath, target)
    return wslPlan ? refreshWslRuntimeUserHooks(wslPlan) : null
  }

  getStatus(runtimeHomePath: string = getOrcaManagedCodexHomePath()): AgentHookInstallStatus {
    return this.getStatusAfterInstall(null, runtimeHomePath)
  }

  private getStatusAfterInstall(
    recentGrantEntries: readonly CodexTrustEntry[] | null,
    runtimeHomePath: string = getOrcaManagedCodexHomePath()
  ): AgentHookInstallStatus {
    return getCodexHookStatusAfterInstall(recentGrantEntries, runtimeHomePath)
  }

  // Why: runtimeHomePath defaults to the shared managed mirror, but a managed
  // account launching against its own self-contained CODEX_HOME passes that
  // per-account home so hooks.json/config.toml/trust land where codex reads.
  install(
    runtimeHomePath: string = getOrcaManagedCodexHomePath()
  ): Promise<AgentHookInstallStatus> {
    // Why: same lane as the grant it performs — see installManagedHooksIntoWslRuntime.
    return runExclusivelyForRuntimeAndSystemTrustConfig(runtimeHomePath, () =>
      this.installExclusively(runtimeHomePath)
    )
  }

  /**
   * Launch prep runs on every local PTY spawn, and both lanes below serialize
   * globally per Codex home, so activating a multi-pane worktree used to pay one
   * full hook install per pane back to back (measured ~790ms for 7 panes, and a
   * resumed Codex pane prepares twice). Spawns racing for the same home all want
   * the same on-disk outcome, so they share one run — the same reason the WSL
   * lane above shares `installForRuntimeHome`.
   *
   * Invalidation: `dedupeInFlightRun` drops the run the moment it settles, so the
   * next launch re-reads hooks.json and the user's trust state. Never widen this
   * into a time-based cache — the hooks setting, ~/.codex approvals and the
   * managed script can all change between spawns, and only a fresh run sees them.
   */
  installForLaunchPrep(runtimeHomePath?: string): Promise<AgentHookInstallStatus> {
    const homePath = runtimeHomePath ?? getOrcaManagedCodexHomePath()
    return dedupeInFlightRun(this.launchPrepInFlight, launchPrepKey('install', homePath), () =>
      this.install(homePath)
    )
  }

  refreshRuntimeUserHooksForLaunchPrep(runtimeHomePath?: string): Promise<AgentHookInstallStatus> {
    const homePath = runtimeHomePath ?? getOrcaManagedCodexHomePath()
    return dedupeInFlightRun(this.launchPrepInFlight, launchPrepKey('refresh', homePath), () =>
      this.refreshRuntimeUserHooks(homePath)
    )
  }

  private installExclusively(runtimeHomePath: string): Promise<AgentHookInstallStatus> {
    return installCodexHooksExclusively(runtimeHomePath, (recentGrantEntries, homePath) =>
      this.getStatusAfterInstall(recentGrantEntries, homePath)
    )
  }

  installRemote(
    sftp: SFTPWrapper,
    remoteHome: string,
    options?: { codexHomeDir?: string; deferTrustUntilConfigToml?: boolean }
  ): Promise<AgentHookInstallStatus> {
    return installCodexHooksRemote(sftp, remoteHome, options)
  }

  refreshRuntimeUserHooks(
    runtimeHomePath: string = getOrcaManagedCodexHomePath()
  ): Promise<AgentHookInstallStatus> {
    return runExclusivelyForRuntimeAndSystemTrustConfig(runtimeHomePath, () =>
      this.refreshRuntimeUserHooksExclusively(runtimeHomePath)
    )
  }

  private refreshRuntimeUserHooksExclusively(
    runtimeHomePath: string
  ): Promise<AgentHookInstallStatus> {
    return refreshCodexRuntimeUserHooksExclusively(runtimeHomePath, (homePath) =>
      this.getStatus(homePath)
    )
  }

  remove(): Promise<AgentHookInstallStatus> {
    return runExclusivelyForRuntimeAndSystemTrustConfig(getOrcaManagedCodexHomePath(), () =>
      this.removeExclusively()
    )
  }

  private removeExclusively(): Promise<AgentHookInstallStatus> {
    return removeCodexHooksExclusively(() => this.getStatus())
  }
}
