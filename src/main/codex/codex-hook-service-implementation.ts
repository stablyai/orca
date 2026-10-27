import { win32 as pathWin32 } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { dedupeInFlightRun } from '../in-flight-run-dedupe'
import { refreshManagedScriptIfPresent } from '../agent-hooks/managed-hook-script-refresh'
import { writeManagedScript } from '../agent-hooks/installer-utils'
import { getOrcaManagedCodexHomePath } from './codex-home-paths'
import { getManagedCommand, getManagedScriptPath } from './codex-hook-definition'
import { installCodexHooksExclusively } from './codex-hook-local-install'
import { getManagedCodexHookHome, readStopgapOrcaHashes } from './codex-hook-orca-approvals'
import {
  refreshCodexRuntimeUserHooksExclusively,
  removeCodexHooksExclusively
} from './codex-hook-local-maintenance'
import { installCodexHooksRemote } from './codex-hook-remote-install'
import { getManagedScript } from './codex-hook-script'
import { readCodexHookHomeStatus, readCurrentCodexHookStatus } from './codex-hook-status'
import {
  CODEX_ANSWER_AWAITED,
  CODEX_HOOK_LAUNCH_WAIT_MS,
  readEveryKnownCodexHookHashes,
  resolveCodexHookAnswerForLaunch
} from './codex-hook-hash-lookup'
import { reconcileCodexHooks } from './codex-hook-reconcile'
import { cleanupLegacyManagedHookRepresentations } from './codex-hook-legacy-cleanup'
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

// Separate hooks-on/off and Codex/terminal runs: their trust outcomes and wait budgets differ.
function launchPrepKey(
  lane: 'install' | 'codex-launch' | 'refresh',
  runtimeHomePath: string
): string {
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
    isHooksEnabled: () => boolean,
    launchesCodex: boolean
  ): Promise<AgentHookInstallStatus> {
    if (isHooksEnabled()) {
      // Install hooks into the managed account's launch home, where its Codex reads trust.
      return (
        (await this.installForRuntimeHomeSerialized(runtimeHomePath, target)) ??
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
    const answer =
      (await resolveCodexHookAnswerForLaunch(launchesCodex ? CODEX_HOOK_LAUNCH_WAIT_MS : 0)) ??
      CODEX_ANSWER_AWAITED
    return runExclusivelyForRuntimeAndSystemTrustConfig(runtimeHomePath, () => {
      // Recheck in the queue so an Off that landed during hash lookup wins.
      if (!isHooksEnabled() || answer.kind === 'refused') {
        return refreshCodexRuntimeUserHooksExclusively(runtimeHomePath, (homePath) =>
          readCodexHookHomeStatus(homePath, answer)
        )
      }
      // Keep known/local approvals usable while Codex's answer is pending.
      const hashes =
        answer.kind === 'hashes'
          ? answer.hashes
          : readStopgapOrcaHashes(
              getManagedCodexHookHome(runtimeHomePath),
              getManagedCommand(getManagedScriptPath())
            )
      return installCodexHooksExclusively(runtimeHomePath, hashes, (homePath) =>
        readCodexHookHomeStatus(homePath, answer)
      )
    })
  }

  // Share concurrent preparation per home; a time cache would miss settings, approvals or script changes.
  installForLaunchPrep(
    runtimeHomePath: string | undefined,
    launchesCodex: boolean,
    isHooksEnabled: () => boolean
  ): Promise<AgentHookInstallStatus> {
    const homePath = runtimeHomePath ?? getOrcaManagedCodexHomePath()
    return dedupeInFlightRun(
      this.launchPrepInFlight,
      launchPrepKey(launchesCodex ? 'codex-launch' : 'install', homePath),
      () => this.install(homePath, launchesCodex, isHooksEnabled)
    )
  }

  refreshRuntimeUserHooksForLaunchPrep(runtimeHomePath?: string): Promise<AgentHookInstallStatus> {
    const homePath = runtimeHomePath ?? getOrcaManagedCodexHomePath()
    return dedupeInFlightRun(this.launchPrepInFlight, launchPrepKey('refresh', homePath), () =>
      this.refreshRuntimeUserHooks(homePath)
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
    // Include older Codex versions' hashes still held by the mirror.
    return removeCodexHooksExclusively(readEveryKnownCodexHookHashes(), () => this.getStatus())
  }
}
