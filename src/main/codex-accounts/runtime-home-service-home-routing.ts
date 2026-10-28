import {
  codexLoginHome,
  prepareCodexCatalogHome,
  discoverCodexStoreHomes
} from '../codex/codex-launch-home'
import { resolveHostCodexSessionSourceHome } from '../codex/codex-session-source-home'
import { posix as pathPosix } from 'node:path'
import { parseWslUncPath, toLinuxPath, toWindowsWslUncPath } from '../../shared/wsl-paths'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { getDefaultWslDistro, getWslHome } from '../wsl'
import { isWslDistroRunning } from '../wsl-background-distro-gate'
import {
  getSystemCodexHomePath,
  resolveOrcaManagedCodexHomePath,
  syncCodexGlobalInstructionsIntoManagedHome,
  syncSystemCodexResourcesIntoManagedHome
} from '../codex/codex-home-paths'
import { syncSystemConfigIntoManagedCodexHome } from '../codex/codex-config-mirror'
import {
  getWslSelectionKey,
  normalizeCodexRuntimeSelection,
  type CodexAccountSelectionTarget
} from './runtime-selection'
import { hasCustomCodexHomeOverrideForLaunch } from '../codex/codex-real-home-path'
import {
  hasRecordedLegacySharedCodexPane,
  getCodexPaneAccount
} from '../codex/codex-pane-account-registry'
import { ManagedCodexHomeTemporarilyUnavailableError } from './host-codex-managed-home-ownership'
import { syncLegacySharedCodexConfigForRetainedPanes } from './legacy-shared-config-compatibility'
import type { CodexManagedAccount } from '../../shared/managed-account-types'
import type { CodexRateLimitHomeResolution } from './runtime-home-service-types'
import { CodexRuntimeHomeManagedHome } from './runtime-home-service-managed-home'

export abstract class CodexRuntimeHomeRouting extends CodexRuntimeHomeManagedHome {
  getHostCodexHomePathsForSessionDiscovery(): string[] {
    // Transcript polling must resolve the mirror path without creating it.
    const homes = [
      resolveOrcaManagedCodexHomePath(),
      ...discoverCodexStoreHomes(this.getManagedAccountsRoot())
    ]
    const source = resolveHostCodexSessionSourceHome(this.store.getSettings())
    if (source) {
      homes.push(source)
    }
    if (this.isHostSystemDefaultRealHomeSelected() || this.getSelfContainedManagedHostAccount()) {
      // Include real-home history even when nested Orca inherits a managed CODEX_HOME.
      homes.push(getSystemCodexHomePath())
    }
    for (const perAccountHome of this.getManagedAccountHomesForSessionDiscovery()) {
      homes.push(perAccountHome)
    }
    return homes.filter((home, index) => homes.indexOf(home) === index)
  }

  /** Read-only host-account home for session discovery; null means no trusted host-account home. */
  getSelectedHostAccountCodexHomePath(): string | null {
    const selfContainedAccount = this.getSelfContainedManagedHostAccount()
    return selfContainedAccount
      ? this.getTrustedSelfContainedManagedHomePath(selfContainedAccount)
      : null
  }

  /** Refuse unreadable homes so resume cannot silently select another account's alias (#STA-4422). */
  resolveSelectedHostAccountCodexHomePathForResume(): string | null {
    const selfContainedAccount = this.getSelfContainedManagedHostAccount()
    if (!selfContainedAccount) {
      return null
    }
    const resolved = this.resolveSelfContainedManagedHome(selfContainedAccount)
    if (resolved.kind === 'indeterminate') {
      throw new ManagedCodexHomeTemporarilyUnavailableError()
    }
    if (resolved.kind === 'untrusted') {
      this.clearSelfContainedManagedSelection(selfContainedAccount)
      return null
    }
    return resolved.homePath
  }

  /** Trust-gates host previews without changing WSL routing or durable account state. */
  resolveCodexManagedAccountHomeForInactiveFetch(
    account: CodexManagedAccount
  ): { kind: 'ready'; homePath: string } | { kind: 'skip' } {
    if (account.managedHomeRuntime === 'wsl' || this.getWslManagedHomePath(account)) {
      return { kind: 'ready', homePath: account.managedHomePath }
    }
    const resolved = this.resolveSelfContainedManagedHome(account)
    return resolved.kind === 'owned'
      ? { kind: 'ready', homePath: resolved.homePath }
      : { kind: 'skip' }
  }

  getRetainedHostCodexHookHomePaths(ptyIds: readonly string[]): string[] {
    const settings = this.store.getSettings()
    const homes = new Map<string, string>()
    for (const ptyId of ptyIds) {
      const record = getCodexPaneAccount(ptyId)
      if (!record || record.selectionKey !== 'host') {
        continue
      }
      if (record.homeRoute === undefined || record.homeRoute === 'shared-home') {
        const homePath = this.getRuntimeHomePath()
        homes.set(normalizeRuntimePathForComparison(homePath), homePath)
        continue
      }
      if (record.homeRoute !== 'account-home' || !record.accountId) {
        continue
      }
      const account = settings.codexManagedAccounts.find(
        (candidate) => candidate.id === record.accountId
      )
      if (!account || this.getWslManagedHomePath(account)) {
        continue
      }
      const homePath = this.getTrustedSelfContainedManagedHomePath(account)
      if (homePath) {
        homes.set(normalizeRuntimePathForComparison(homePath), homePath)
      }
    }
    return [...homes.values()]
  }

  // Custom CODEX_HOME overrides keep system-default launches on the mirror for legacy cleanup.
  isHostSystemDefaultRealHomeSelected(launchEnv?: NodeJS.ProcessEnv): boolean {
    return (
      normalizeCodexRuntimeSelection(this.store.getSettings()).host === null &&
      !hasCustomCodexHomeOverrideForLaunch(launchEnv)
    )
  }

  reconcileLegacySharedHomeForRetainedPanes(): void {
    if (!this.isHostSystemDefaultRealHomeSelected() || !hasRecordedLegacySharedCodexPane()) {
      return
    }
    this.syncLegacySharedSystemDefaultAuthForRetainedPanes()
    syncLegacySharedCodexConfigForRetainedPanes()
  }

  // A null system baseline allows one mirror-login import; recording the baseline ends eligibility.
  protected copyMirrorLoginIntoEmptySystemHome(): void {
    if (process.platform !== 'win32') {
      return
    }
    try {
      const provenance = this.resolveSharedRuntimeAuthProvenanceStatus()
      const runtimeAuth = this.readRuntimeAuthForProvenance()
      if (
        provenance.kind !== 'committed' ||
        provenance.provenance.owner !== 'system-default' ||
        provenance.provenance.authJson !== null ||
        runtimeAuth === null
      ) {
        return
      }
      const copied = this.writeSystemDefaultAuth(runtimeAuth, { expectedContents: null })
      // Record even declined copies so a later logout cannot resurrect this stale login (#5370).
      this.persistSharedRuntimeAuthProvenance({ owner: 'system-default', authJson: runtimeAuth })
      if (copied) {
        this.captureSystemDefaultSnapshot({ force: true })
      }
    } catch (error) {
      console.warn('[codex-runtime-home] Failed to copy the mirror login into ~/.codex:', error)
    }
  }

  /** Preserve refreshed auth from retained legacy WSL panes before restart. */
  async syncActiveWslSelectionsBeforeRestart(): Promise<void> {
    if (process.platform !== 'win32') {
      return
    }
    const settings = this.store.getSettings()
    const drains: Promise<void>[] = []
    for (const [selectedDistroKey, accountId] of Object.entries(
      normalizeCodexRuntimeSelection(settings).wsl
    )) {
      if (!accountId) {
        continue
      }
      const account = this.getActiveAccount(settings.codexManagedAccounts, accountId)
      if (!account || account.managedHomeRuntime !== 'wsl') {
        continue
      }
      const distro =
        selectedDistroKey === getWslSelectionKey(null)
          ? account.wslDistro?.trim() || null
          : selectedDistroKey.trim() || null
      if (distro) {
        // Stopped distros have no live panes to drain; their next launch drains before spawning.
        drains.push(
          isWslDistroRunning(distro).then((running) =>
            running
              ? this.startLegacyWslAuthDrain({ runtime: 'wsl', wslDistro: distro })
              : undefined
          )
        )
      }
    }
    await Promise.all(drains)
  }

  protected getWslSystemCodexHomePath(target: CodexAccountSelectionTarget): string | null {
    if (process.platform !== 'win32') {
      return null
    }
    const distro = target.wslDistro?.trim() || getDefaultWslDistro()
    if (!distro) {
      return null
    }
    const home = getWslHome(distro)
    if (home && /^[A-Za-z]:[\\/]/.test(home)) {
      const linuxHome = toLinuxPath(home).trim()
      return linuxHome.startsWith('/')
        ? toWindowsWslUncPath(pathPosix.join(linuxHome, '.codex'), distro)
        : null
    }
    return home ? this.joinWslPath(home, '.codex') : null
  }

  protected finishWslLaunchPreparation(
    target: CodexAccountSelectionTarget,
    homePath: string | null
  ): void {
    this.syncWslConfigAndGlobalInstructionsForLaunch(target, homePath)
    this.startWslSessionBridgeForLaunch(target, homePath)
  }

  protected syncWslConfigAndGlobalInstructionsForLaunch(
    target: CodexAccountSelectionTarget,
    runtimeHomePath: string | null
  ): void {
    if (!runtimeHomePath) {
      return
    }
    const distro =
      parseWslUncPath(runtimeHomePath)?.distro || target.wslDistro?.trim() || getDefaultWslDistro()
    if (!distro) {
      return
    }
    const systemHomePath = this.getWslSystemCodexHomePath({ runtime: 'wsl', wslDistro: distro })
    if (!systemHomePath || systemHomePath === runtimeHomePath) {
      return
    }
    // Distro-local homes need the guest user's instructions, which host resource mirroring cannot supply.
    syncCodexGlobalInstructionsIntoManagedHome({
      systemHomePath,
      managedHomePath: runtimeHomePath
    })
    syncSystemConfigIntoManagedCodexHome({
      runtimeHomePath,
      systemHomePath,
      systemConfigDir: toLinuxPath(systemHomePath)
    })
  }

  // A skipped poll needs a distinct result: null routes the fetcher to system default (#STA-4422).
  prepareForRateLimitFetch(target?: CodexAccountSelectionTarget): CodexRateLimitHomeResolution {
    if (target?.runtime === 'wsl') {
      const wslTarget = this.resolveWslDefaultTarget(target)
      return {
        kind: 'ready',
        codexHomePath: this.getPreparedWslRateLimitHomePath(wslTarget)
      }
    }
    const selfContainedAccount = this.getSelfContainedManagedHostAccount()
    if (selfContainedAccount) {
      const resolved = this.resolveSelfContainedManagedHome(selfContainedAccount)
      if (resolved.kind === 'owned') {
        // Quota probes read account auth in place; resource synchronization belongs to launch prep.
        return { kind: 'ready', codexHomePath: resolved.homePath }
      }
      if (resolved.kind === 'indeterminate') {
        return { kind: 'skip' }
      }
      this.clearSelfContainedManagedSelection(selfContainedAccount)
    }
    if (this.isHostSystemDefaultRealHomeSelected()) {
      this.copyMirrorLoginIntoEmptySystemHome()
      if (hasRecordedLegacySharedCodexPane()) {
        this.syncLegacySharedSystemDefaultAuthForRetainedPanes()
      }
      // Pin the native home so nested Orca cannot inherit a managed-home OAuth conflict (#5370).
      return { kind: 'ready', codexHomePath: getSystemCodexHomePath() }
    }
    this.syncMirrorForReadOnlyAppServer()
    return { kind: 'ready', codexHomePath: this.getRuntimeHomePath() }
  }

  /** Sync shared-mirror credentials for catalog probes; per-account homes already own their auth. */
  prepareHostCodexHomeForReadOnlyAppServer(homePath: string, launchEnv?: NodeJS.ProcessEnv): void {
    const account = this.store
      .getSettings()
      .codexManagedAccounts.find(
        (candidate) =>
          normalizeRuntimePathForComparison(candidate.managedHomePath) ===
          normalizeRuntimePathForComparison(codexLoginHome(homePath))
      )
    const loginHome = account ? this.getTrustedSelfContainedManagedHomePath(account) : null
    const options = {
      selectedAccount: loginHome ? { homePath: loginHome } : null,
      accountsRoot: this.getManagedAccountsRoot(),
      storeHome: resolveHostCodexSessionSourceHome(this.store.getSettings())
    }
    prepareCodexCatalogHome(homePath, options, this.getHostCodexHomePathsForSessionDiscovery())
    if (
      this.getSelfContainedManagedHostAccount() ||
      normalizeRuntimePathForComparison(homePath) !==
        normalizeRuntimePathForComparison(resolveOrcaManagedCodexHomePath())
    ) {
      return
    }
    this.syncMirrorForReadOnlyAppServer(launchEnv)
  }

  private syncMirrorForReadOnlyAppServer(launchEnv?: NodeJS.ProcessEnv): void {
    this.syncForCurrentSelection(undefined, launchEnv)
    syncSystemCodexResourcesIntoManagedHome()
    syncSystemConfigIntoManagedCodexHome()
  }
}
