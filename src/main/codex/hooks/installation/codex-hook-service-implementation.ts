import { win32 as pathWin32 } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallStatus } from '../../../../shared/agent-hook-listener/configuration/agent-hook-types'
import { dedupeInFlightRun } from '../../../runtime/concurrency/in-flight-run-dedupe'
import { refreshManagedScriptIfPresent } from '../../../agent-hooks/installation/scripts/managed-hook-script-refresh'
import { writeManagedScript } from '../../../agent-hooks/installation/scripts/managed-hook-script-write'
import { getOrcaManagedCodexHomePath } from '../../configuration/homes/codex-home-paths'
import { getManagedScriptPath } from '../definitions/codex-hook-definition'
import {
  refreshCodexRuntimeUserHooksExclusively,
  removeCodexHooksExclusively
} from './codex-hook-local-maintenance'
import { installCodexHooksRemote } from './codex-hook-remote-install'
import { getManagedScript } from '../definitions/codex-hook-script'
import { readCurrentCodexHookStatus } from '../reconciliation/codex-hook-status'
import { readEveryKnownCodexHookHashes } from '../../trust/hooks/codex-hook-hash-lookup'
import { reconcileCodexHooks } from '../reconciliation/codex-hook-reconcile'
import { cleanupLegacyManagedHookRepresentations } from '../reconciliation/codex-hook-legacy-cleanup'
import { removeStaleWslRuntimeManagedHookTrustEntries } from '../../trust/hooks/codex-hook-trust-cleanup'
import { runExclusivelyForRuntimeAndSystemTrustConfig } from '../../trust/hooks/codex-hook-trust-queue'
import {
  getWslHookReconciliationAction,
  installManagedHooksIntoWslRuntime,
  isWslHookDistroBlocked,
  skippedWslHookInstallStatus,
  refreshWslRuntimeUserHooks
} from './codex-hook-wsl-runtime'
import { normalizeCodexTrustProjectPath as getWslReconciliationKey } from '../../trust/identity/codex-trust-identity'
import {
  createCodexWslRuntimeHookInstallPlan,
  isCodexWslRuntimeHome,
  type CodexWslRuntimeHookTarget,
  type WslCanonicalPathSettlement
} from './codex-wsl-hook-install-plan'
import { CodexHookLaunchPreparation } from './codex-hook-launch-preparation'

export class CodexHookService {
  async refreshManagedScripts(): Promise<void> {
    this.localLaunchPreparation.clear()
    await refreshManagedScriptIfPresent(getManagedScriptPath(), getManagedScript())
  }

  private readonly wslReconciliationGeneration = new Map<string, number>()
  private readonly wslInstallsInFlight = new Map<string, Promise<AgentHookInstallStatus | null>>()
  private readonly localLaunchPreparation = new CodexHookLaunchPreparation()

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
    // Canonical-path callbacks must wait for the async install to finish updating its flags.
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
      // The probe settled after the install; the distro may have stopped since (E9).
      const distro = resolvedPlan?.wslDistro ?? wslPlan?.wslDistro
      if (!distro || (await isWslHookDistroBlocked(distro))) {
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
      if (!status) {
        return
      }
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
    isHooksEnabled: () => boolean,
    launchesCodex: boolean
  ): Promise<AgentHookInstallStatus> {
    if (isHooksEnabled()) {
      // Install hooks into the managed account's launch home, where its Codex reads trust.
      const wslStatus = await this.installForRuntimeHomeSerialized(runtimeHomePath, target)
      // A WSL home skipped for a stopped distro must not fall to the host writer, over UNC.
      if (!wslStatus && runtimeHomePath && isCodexWslRuntimeHome(runtimeHomePath, target)) {
        return skippedWslHookInstallStatus(runtimeHomePath)
      }
      return (
        wslStatus ??
        (await this.installForLaunchPrep(
          runtimeHomePath ?? undefined,
          launchesCodex,
          isHooksEnabled
        ))
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

  getStatus(runtimeHomePath?: string): AgentHookInstallStatus {
    return readCurrentCodexHookStatus(runtimeHomePath)
  }

  /** App start and explicit enablement may convert older builds' real-home entries. */
  async reconcileHooks(): Promise<AgentHookInstallStatus> {
    this.localLaunchPreparation.clear()
    try {
      writeManagedScript(getManagedScriptPath(), getManagedScript())
    } catch (error) {
      console.warn('[codex-hook-service] could not write the Codex hook script:', error)
    }
    await reconcileCodexHooks({ convertOlderForms: true })
    await cleanupLegacyManagedHookRepresentations()
    return this.getStatus()
  }

  // Managed accounts pass their own CODEX_HOME; plain terminal launches skip waiting for Codex's answer.
  async install(
    runtimeHomePath: string = getOrcaManagedCodexHomePath(),
    launchesCodex = true,
    isHooksEnabled: () => boolean = () => true
  ): Promise<AgentHookInstallStatus> {
    this.localLaunchPreparation.clear()
    return this.localLaunchPreparation.install(runtimeHomePath, launchesCodex, isHooksEnabled)
  }

  // Reuse only a complete pass whose actual observations and fresh inputs still agree.
  installForLaunchPrep(
    runtimeHomePath: string | undefined,
    launchesCodex: boolean,
    isHooksEnabled: () => boolean
  ): Promise<AgentHookInstallStatus> {
    return this.localLaunchPreparation.installForLaunchPrep(
      runtimeHomePath ?? getOrcaManagedCodexHomePath(),
      launchesCodex,
      isHooksEnabled
    )
  }
  refreshRuntimeUserHooksForLaunchPrep(runtimeHomePath?: string): Promise<AgentHookInstallStatus> {
    return this.localLaunchPreparation.refreshRuntimeUserHooksForLaunchPrep(
      runtimeHomePath ?? getOrcaManagedCodexHomePath(),
      (home) => this.getStatus(home)
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
    this.localLaunchPreparation.clear()
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
    this.localLaunchPreparation.clear()
    return runExclusivelyForRuntimeAndSystemTrustConfig(getOrcaManagedCodexHomePath(), () =>
      this.removeExclusively()
    )
  }

  private removeExclusively(): Promise<AgentHookInstallStatus> {
    // Include older Codex versions' hashes still held by the mirror.
    return removeCodexHooksExclusively(readEveryKnownCodexHookHashes(), () => this.getStatus())
  }
}
