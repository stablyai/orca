import { resolveHostCodexSessionSourceHome } from '../codex/history/rollouts/codex-session-source-home'
import { startSystemCodexSessionBridgeInBackground } from '../codex/history/bridges/codex-session-bridge'
import { startCodexAccountSessionBridgeInBackground } from '../codex/history/bridges/codex-account-session-bridge'
import { isCodexHistorySharedAcrossAccounts } from './codex-history-sharing'
import {
  getSystemCodexHomePath,
  resolveOrcaManagedCodexHomePath,
  syncSystemCodexResourcesIntoManagedHome
} from '../codex/configuration/homes/codex-home-paths'
import { syncSystemConfigIntoManagedCodexHome } from '../codex/configuration/settings/codex-config-mirror'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import {
  normalizeCodexRuntimeSelection,
  type CodexAccountSelectionTarget
} from './runtime-selection'
import { hasCustomCodexHomeOverrideForLaunch } from '../codex/configuration/homes/codex-real-home-path'
import { markCodexSessionBackfillMarkerPending } from '../codex/history/backfill/codex-session-backfill-marker'
import { getCodexSessionBackfillDate } from '../codex/history/backfill/codex-session-backfill-scan-dates'
import { resolveCodexSessionBackfillPaths } from '../codex/history/backfill/codex-session-backfill'
import type { CodexSessionBackfillDate } from '../codex/history/backfill/codex-session-backfill-types'
import {
  ManagedCodexHomeTemporarilyUnavailableError,
  PINNED_CODEX_HOME_UNUSABLE_MESSAGE
} from './host-codex-managed-home-ownership'
import { CodexRuntimeHomeRouting } from './runtime-home-service-home-routing'
import { projectPinnedCodexAccount } from './codex-project-pin'
import type { CodexManagedAccount } from '../../shared/managed-account-types'
import { blockedWslDistroForExec } from '../wsl/discovery/wsl-background-exec-gate'
import { getWslHomeAsync } from '../wsl/discovery/distro-catalog'

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

  /** The saved host account a worktree's project pins; a removed or WSL one pins nothing. */
  protected getProjectPinnedHostAccount(worktreeId?: string): CodexManagedAccount | null {
    const account = projectPinnedCodexAccount(this.store, worktreeId)
    return account && !this.getWslManagedHomePath(account) ? account : null
  }

  /** A pinned project's own home. Unlike a selected account it never moves or clears the selection,
   *  and it refuses rather than run the launch under another account. */
  protected preparePinnedManagedHomeForLaunch(account: CodexManagedAccount): string {
    const resolved = this.resolveSelfContainedManagedHome(account)
    if (resolved.kind === 'indeterminate') {
      throw new ManagedCodexHomeTemporarilyUnavailableError()
    }
    if (resolved.kind === 'untrusted') {
      throw new Error(PINNED_CODEX_HOME_UNUSABLE_MESSAGE)
    }
    syncSystemCodexResourcesIntoManagedHome(resolved.homePath)
    syncSystemConfigIntoManagedCodexHome({
      runtimeHomePath: resolved.homePath,
      systemHomePath: getSystemCodexHomePath()
    })
    this.startSelfContainedSessionBridgeForLaunch(resolved.homePath)
    return resolved.homePath
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
    const pinned = this.getProjectPinnedHostAccount(target?.worktreeId)
    if (pinned) {
      return this.preparePinnedManagedHomeForLaunch(pinned)
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
  resolveHostCodexHomePathForLaunchReadOnly(
    launchEnv?: NodeJS.ProcessEnv,
    worktreeId?: string
  ): string | null {
    const pinned = this.getProjectPinnedHostAccount(worktreeId)
    const selfContainedAccount = pinned ?? this.getSelfContainedManagedHostAccount()
    if (selfContainedAccount) {
      const resolved = this.resolveSelfContainedManagedHome(selfContainedAccount)
      if (resolved.kind === 'owned') {
        return resolved.homePath
      }
      if (resolved.kind === 'indeterminate') {
        // Keep reads under the selected account; an unreadable home cannot imply system default.
        throw new ManagedCodexHomeTemporarilyUnavailableError()
      }
      if (pinned) {
        throw new Error(PINNED_CODEX_HOME_UNUSABLE_MESSAGE)
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

  /** A pinned project's home, for resumes and restarts; null when the project pins nothing. */
  resolveProjectPinnedHostCodexHomePathForResume(worktreeId?: string): string | null {
    const pinned = this.getProjectPinnedHostAccount(worktreeId)
    if (!pinned) {
      return null
    }
    const resolved = this.resolveSelfContainedManagedHome(pinned)
    if (resolved.kind === 'indeterminate') {
      throw new ManagedCodexHomeTemporarilyUnavailableError()
    }
    if (resolved.kind === 'untrusted') {
      throw new Error(PINNED_CODEX_HOME_UNUSABLE_MESSAGE)
    }
    return resolved.homePath
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
    // A passive restore reaches this before its hold (#35813); the probe, drain, sync and bridge
    // below would each start a stopped distro (E9). A user act passes and does them all.
    if (await blockedWslDistroForExec(wslTarget.wslDistro)) {
      return this.getWslCodexHomePathForSelection(wslTarget, { probeHome: false })
    }
    const distro = wslTarget.wslDistro?.trim()
    if (distro && process.platform === 'win32') {
      // Warm the guest-home cache off the main thread, so the sync reads below skip a 5 s wsl.exe.
      await getWslHomeAsync(distro)
    }
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
