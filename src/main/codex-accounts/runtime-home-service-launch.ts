import { resolveHostCodexSessionSourceHome } from '../codex/codex-session-source-home'
import { startSystemCodexSessionBridgeInBackground } from '../codex/codex-session-bridge'
import { startCodexAccountSessionBridgeInBackground } from '../codex/codex-account-session-bridge'
import { isCodexHistorySharedAcrossAccounts } from './codex-history-sharing'
import {
  getSystemCodexHomePath,
  resolveOrcaManagedCodexHomePath,
  syncSystemCodexResourcesIntoManagedHome
} from '../codex/codex-home-paths'
import { syncSystemConfigIntoManagedCodexHome } from '../codex/codex-config-mirror'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import {
  normalizeCodexRuntimeSelection,
  type CodexAccountSelectionTarget
} from './runtime-selection'
import { hasCustomCodexHomeOverrideForLaunch } from '../codex/codex-real-home-path'
import { markCodexSessionBackfillMarkerPending } from '../codex/codex-session-backfill-marker'
import { getCodexSessionBackfillDate } from '../codex/codex-session-backfill-scan-dates'
import { resolveCodexSessionBackfillPaths } from '../codex/codex-session-backfill'
import type { CodexSessionBackfillDate } from '../codex/codex-session-backfill-types'
import { ManagedCodexHomeTemporarilyUnavailableError } from './host-codex-managed-home-ownership'
import { CodexRuntimeHomeRouting } from './runtime-home-service-home-routing'

export abstract class CodexRuntimeHomeLaunch extends CodexRuntimeHomeRouting {
  protected initializeLastSyncedState(): void {
    const settings = this.store.getSettings()
    const activeAccount = this.getActiveAccount(
      settings.codexManagedAccounts,
      normalizeCodexRuntimeSelection(settings).host
    )
    // WSL selection must not make cold-start reconciliation treat host auth as previously managed.
    this.lastSyncedAccountId = this.getWslManagedHomePath(activeAccount)
      ? null
      : normalizeCodexRuntimeSelection(settings).host
  }

  /** Prepare the launch home without waiting for background history bridging. */
  prepareForCodexLaunch(
    target?: CodexAccountSelectionTarget,
    launchEnv?: NodeJS.ProcessEnv,
    options?: { unavailableManagedHomePath?: string }
  ): string | null {
    if (target?.runtime === 'wsl') {
      const wslTarget = this.resolveWslDefaultTarget(target)
      const homePath = this.getWslCodexHomePathForSelection(wslTarget)
      this.startLegacyWslAuthDrain(wslTarget)
      this.finishWslLaunchPreparation(wslTarget, homePath)
      return homePath
    }
    const selfContainedAccount = this.getSelfContainedManagedHostAccount()
    if (selfContainedAccount) {
      const perAccountHome = this.prepareSelfContainedManagedHomeForLaunch(
        selfContainedAccount,
        options?.unavailableManagedHomePath
      )
      if (perAccountHome) {
        return perAccountHome
      }
    }
    if (this.isHostSystemDefaultRealHomeSelected(launchEnv)) {
      // Null leaves CODEX_HOME uninjected; refresh the retired mirror only for retained panes.
      this.copyMirrorLoginIntoEmptySystemHome()
      this.reconcileLegacySharedHomeForRetainedPanes()
      this.startSystemDefaultSessionBridgeForLaunch()
      return null
    }
    this.invalidateBackfillAfterManagedSystemDefaultLaunch(launchEnv)
    this.syncForCurrentSelection(target, launchEnv)
    syncSystemCodexResourcesIntoManagedHome()
    syncSystemConfigIntoManagedCodexHome()
    // Keep large history scans off the launch path.
    if (
      isCodexHistorySharedAcrossAccounts(this.store.getSettings()) &&
      !this.isHostHistorySourceInWsl()
    ) {
      void startSystemCodexSessionBridgeInBackground(
        {},
        resolveHostCodexSessionSourceHome(this.store.getSettings())
      )
    }
    return this.getRuntimeHomePath()
  }

  // Real-home launches see managed-account history too, or switching back to system default hides it (#25000).
  private startSystemDefaultSessionBridgeForLaunch(): void {
    const settings = this.store.getSettings()
    const sourceCodexHomePaths = this.getManagedHostAccountHomesForSessionDiscovery()
    const targetCodexHomePath =
      resolveHostCodexSessionSourceHome(settings) ?? getSystemCodexHomePath()
    if (
      sourceCodexHomePaths.length === 0 ||
      !isCodexHistorySharedAcrossAccounts(settings) ||
      this.isHostHistorySourceInWsl()
    ) {
      return
    }
    // The user's own ~/.codex gets hardlinks or nothing: a symlink there dangles once an account goes.
    void startCodexAccountSessionBridgeInBackground({
      targetCodexHomePath,
      sourceCodexHomePaths,
      hardlinkOnly: true
    })
  }

  /** Resolve the launch home without side effects for catalog reads; null means real ~/.codex. */
  resolveHostCodexHomePathForLaunchReadOnly(launchEnv?: NodeJS.ProcessEnv): string | null {
    const selfContainedAccount = this.getSelfContainedManagedHostAccount()
    if (selfContainedAccount) {
      const resolved = this.resolveSelfContainedManagedHome(selfContainedAccount)
      if (resolved.kind === 'owned') {
        return resolved.homePath
      }
      if (resolved.kind === 'indeterminate') {
        // Keep reads under the selected account; an unreadable home cannot imply system default.
        throw new ManagedCodexHomeTemporarilyUnavailableError()
      }
      // Predict launch's route after deselection while leaving the selection untouched.
      return !hasCustomCodexHomeOverrideForLaunch(launchEnv)
        ? null
        : resolveOrcaManagedCodexHomePath()
    }
    // Avoid getRuntimeHomePath(), which creates the mirror directory.
    return this.isHostSystemDefaultRealHomeSelected(launchEnv)
      ? null
      : resolveOrcaManagedCodexHomePath()
  }

  async prepareForCodexLaunchAsync(
    target?: CodexAccountSelectionTarget,
    launchEnv?: NodeJS.ProcessEnv,
    options?: { unavailableManagedHomePath?: string }
  ): Promise<string | null> {
    if (target?.runtime !== 'wsl') {
      return this.prepareForCodexLaunch(target, launchEnv, options)
    }
    const wslTarget = this.resolveWslDefaultTarget(target)
    const homePath = this.getWslCodexHomePathForSelection(wslTarget)
    // Drain potentially fresher retired-home credentials before the first direct-home spawn.
    await this.startLegacyWslAuthDrain(wslTarget, { throwOnFailure: true })
    this.finishWslLaunchPreparation(wslTarget, homePath)
    return homePath
  }

  beginHostSystemDefaultSessionMigrationLaunch(
    codexHomePath: string | null,
    options: { reattached?: boolean; launchEnv?: NodeJS.ProcessEnv } = {}
  ): boolean | null {
    // A WSL source still reaches invalidation, which records the full scan its launch will owe.
    if (
      !this.isHostSystemDefaultSessionMigrationRouteSelected() ||
      (!codexHomePath && !options.reattached) ||
      (codexHomePath &&
        normalizeRuntimePathForComparison(codexHomePath) !==
          normalizeRuntimePathForComparison(this.getRuntimeHomePath()))
    ) {
      return null
    }
    // An older pass can clear launch preparation while PTY spawn awaits recovery.
    return this.invalidateBackfillAfterManagedSystemDefaultLaunch(
      options.reattached && !codexHomePath ? undefined : options.launchEnv
    )
  }

  isHostSystemDefaultSessionMigrationEligible(): boolean {
    return (
      this.isHostSystemDefaultSessionMigrationRouteSelected() && !this.isHostHistorySourceInWsl()
    )
  }

  private isHostSystemDefaultSessionMigrationRouteSelected(): boolean {
    return (
      normalizeCodexRuntimeSelection(this.store.getSettings()).host === null &&
      !hasCustomCodexHomeOverrideForLaunch()
    )
  }

  prepareHostSystemDefaultSessionMigrationPass(
    scanDates: readonly CodexSessionBackfillDate[] = []
  ): boolean {
    if (this.isHostHistorySourceInWsl()) {
      return false
    }
    const paths = resolveCodexSessionBackfillPaths(
      resolveHostCodexSessionSourceHome(this.store.getSettings())
    )
    const target = normalizeRuntimePathForComparison(paths.systemSessionsRoot)
    if (
      this.hostSystemDefaultSessionMigrationPending &&
      this.pendingHostSystemDefaultSessionMigrationTarget !== target
    ) {
      this.pendingHostSystemDefaultSessionMigrationNeedsFullScan = true
      this.pendingHostSystemDefaultSessionMigrationTarget = target
    }
    // Persist rollout dates so force-quit recovery scans a bounded window.
    const markerOwesFullScan = markCodexSessionBackfillMarkerPending(
      paths.markerPath,
      paths.systemSessionsRoot,
      scanDates.length > 0 ? scanDates : [getCodexSessionBackfillDate()]
    )
    // Carry the marker's full-scan requirement across restarts after pending-window overflow.
    this.pendingHostSystemDefaultSessionMigrationNeedsFullScan ||= markerOwesFullScan
    return this.pendingHostSystemDefaultSessionMigrationNeedsFullScan
  }

  finishHostSystemDefaultSessionMigrationPass(): void {
    this.hostSystemDefaultSessionMigrationPending = false
    this.pendingHostSystemDefaultSessionMigrationNeedsFullScan = false
    this.pendingHostSystemDefaultSessionMigrationTarget = null
  }
}
