import { resolveHostCodexSessionSourceHome } from '../../../codex/history/rollouts/codex-session-source-home'
import { startSystemCodexSessionBridgeInBackground } from '../../../codex/history/bridges/codex-session-bridge'
import { isCodexHistorySharedAcrossAccounts } from './codex-history-sharing'
import {
  getOrcaManagedCodexHomePath,
  getSystemCodexHomePath,
  resolveOrcaManagedCodexHomePath,
  getSystemCodexHomePath,
  syncSystemCodexResourcesIntoManagedHome
} from '../../../codex/configuration/homes/codex-home-paths'
import { syncSystemConfigIntoManagedCodexHome } from '../../../codex/configuration/settings/codex-config-mirror'
import { normalizeRuntimePathForComparison } from '../../../../shared/file-access/cross-platform-path'
import { normalizeCodexRuntimeSelection } from '../../account-management/runtime-selection'
import type { CodexAccountSelectionTarget } from '../../../../shared/agent-accounts/codex/codex-selection-lane'
import { hasCustomCodexHomeOverrideForLaunch } from '../../../codex/configuration/homes/codex-real-home-path'
import {
  markCodexSessionBackfillMarkerNeedsFullScan,
  markCodexSessionBackfillMarkerPending
} from '../../../codex/history/backfill/codex-session-backfill-marker'
import { resolveCodexSessionBackfillPaths } from '../../../codex/history/backfill/codex-session-backfill'
import { ManagedCodexHomeTemporarilyUnavailableError } from '../../managed-homes/host-codex-managed-home-ownership'
import { CodexRuntimeHomeWorkspaceRouting } from './runtime-home-workspace-routing'
import { blockedWslDistroForExec } from '../../../wsl/discovery/wsl-background-exec-gate'
import { getWslHomeAsync } from '../../../wsl/discovery/distro-catalog'
import type { CodexHomeLaunchOptions } from '../runtime-home-service-types'

export abstract class CodexRuntimeHomeLaunch extends CodexRuntimeHomeWorkspaceRouting {
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
    options?: CodexHomeLaunchOptions
  ): string | null {
    if (this.workspaceUsesSystemDefault(options?.workspaceId)) {
      return target?.runtime === 'wsl'
        ? this.getWslSystemCodexHomePath(target, { probeHome: false })
        : getSystemCodexHomePath()
    }
    const workspaceAccount = this.workspaceAccount(options?.workspaceId, target)
    if (workspaceAccount) {
      const home = this.workspaceAccountHome(workspaceAccount, target)
      if (target?.runtime === 'wsl') {
        this.finishWslLaunchPreparation(target, home)
        return home
      }
      const prepared = this.prepareSelfContainedManagedHomeForLaunch(
        workspaceAccount,
        options?.unavailableManagedHomePath,
        options?.deferConfigSync
      )
      if (!prepared) {
        throw new Error('The workspace Codex account home is unavailable.')
      }
      return prepared
    }
    if (target?.runtime === 'wsl') {
      const wslTarget = this.resolveWslDefaultTarget(target)
      const homePath = this.getWslCodexHomePathForSelection(wslTarget)
      this.startLegacyWslAuthDrain(wslTarget)
      this.finishWslLaunchPreparation(wslTarget, homePath)
      void this.prepareWslAccountHistory(wslTarget, homePath)
      return homePath
    }
    const selfContainedAccount = this.getSelfContainedManagedHostAccount()
    if (selfContainedAccount) {
      const perAccountHome = this.prepareSelfContainedManagedHomeForLaunch(
        selfContainedAccount,
        options?.unavailableManagedHomePath,
        options?.deferConfigSync
      )
      if (perAccountHome) {
        return perAccountHome
      }
    }
    if (this.isHostSystemDefaultRealHomeSelected(launchEnv)) {
      // Null leaves CODEX_HOME uninjected; refresh the retired mirror only for retained panes.
      this.copyMirrorLoginIntoEmptySystemHome()
      this.reconcileLegacySharedHomeForRetainedPanes()
      return null
    }
    this.invalidateBackfillAfterManagedSystemDefaultLaunch(launchEnv)
    this.syncForCurrentSelection(target, launchEnv)
    syncSystemCodexResourcesIntoManagedHome()
    if (options?.deferConfigSync) {
      options.deferConfigSync({
        runtimeHomePath: getOrcaManagedCodexHomePath(),
        systemHomePath: getSystemCodexHomePath()
      })
    } else {
      syncSystemConfigIntoManagedCodexHome()
    }
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

  /** Resolve the launch home without side effects for catalog reads; null means real ~/.codex. */
  resolveHostCodexHomePathForLaunchReadOnly(
    launchEnv?: NodeJS.ProcessEnv,
    workspaceId?: string
  ): string | null {
    if (this.workspaceUsesSystemDefault(workspaceId)) {
      return getSystemCodexHomePath()
    }
    const workspaceAccount = this.workspaceAccount(workspaceId)
    if (workspaceAccount) {
      return this.workspaceAccountHome(workspaceAccount)
    }
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
    options?: CodexHomeLaunchOptions
  ): Promise<string | null> {
    if (this.workspaceUsesSystemDefault(options?.workspaceId)) {
      if (target?.runtime === 'wsl' && !(await blockedWslDistroForExec(target.wslDistro))) {
        if (target.wslDistro) {
          await getWslHomeAsync(target.wslDistro)
        }
      }
      if (!this.workspaceUsesSystemDefault(options?.workspaceId)) {
        throw new Error('The workspace Codex account changed during preparation. Launch again.')
      }
      return this.prepareForCodexLaunch(target, launchEnv, options)
    }
    const workspaceAccount = this.workspaceAccount(options?.workspaceId, target)
    const sharing = isCodexHistorySharedAcrossAccounts(this.store.getSettings())
    if (workspaceAccount) {
      const home = this.workspaceAccountHome(workspaceAccount, target)
      if (target?.runtime === 'wsl') {
        const wslTarget = this.resolveWslDefaultTarget(target)
        if (await blockedWslDistroForExec(wslTarget.wslDistro)) {
          return home
        }
        await this.startLegacyWslAuthDrain(wslTarget, { throwOnFailure: true })
        await this.prepareWslAccountHistory(wslTarget, home)
      } else {
        await this.prepareAccountHistory(home)
      }
      if (
        this.workspaceAccount(options?.workspaceId, target)?.id !== workspaceAccount.id ||
        sharing !== isCodexHistorySharedAcrossAccounts(this.store.getSettings())
      ) {
        throw new Error('The workspace Codex account changed during preparation. Launch again.')
      }
      return this.prepareForCodexLaunch(target, launchEnv, options)
    }
    if (target?.runtime !== 'wsl') {
      // Codex must start on linked history, so the launched home's pass finishes first; the
      // selection or the setting may change while it runs, so prepare until both held still.
      let prepared: string | null = null
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const account = this.getSelfContainedManagedHostAccount()
        const accountHome = account ? this.getTrustedSelfContainedManagedHomePath(account) : null
        const shared = isCodexHistorySharedAcrossAccounts(this.store.getSettings())
        if (!accountHome || `${accountHome}\0${shared}` === prepared) {
          break
        }
        await this.prepareAccountHistory(accountHome, { forLaunch: true })
        prepared = `${accountHome}\0${shared}`
      }
      if (this.workspaceAccount(options?.workspaceId, target)) {
        throw new Error('The workspace Codex account changed during preparation. Launch again.')
      }
      this.prepareAllAccountHistoryInBackground()
      this.importCodexHistoryInBackground()
      return this.prepareForCodexLaunch(target, launchEnv, options)
    }
    const wslTarget = this.resolveWslDefaultTarget(target)
    // A passive restore reaches this before its hold (#35813); the probe, drain, sync and bridge
    // below would each start a stopped distro (E9). A user act passes and does them all.
    if (await blockedWslDistroForExec(wslTarget.wslDistro)) {
      if (this.workspaceUsesSystemDefault(options?.workspaceId)) {
        throw new Error('The workspace Codex account changed during preparation. Launch again.')
      }
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
    // Codex must start on linked history (and the guest's sqlite_home line) in this home.
    await this.prepareWslAccountHistory(wslTarget, homePath)
    if (
      this.workspaceAccount(options?.workspaceId, target) ||
      this.workspaceUsesSystemDefault(options?.workspaceId) ||
      sharing !== isCodexHistorySharedAcrossAccounts(this.store.getSettings())
    ) {
      throw new Error(
        'The workspace Codex account or history policy changed during preparation. Launch again.'
      )
    }
    // WSL moves aren't counted, but an install with only WSL homes still reports how many.
    this.accountHistoryPasses.reportMoves()
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
    fullScanRequired = false,
    newFullScanRequest = false
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
    this.pendingHostSystemDefaultSessionMigrationNeedsFullScan ||= fullScanRequired
    if (this.pendingHostSystemDefaultSessionMigrationNeedsFullScan) {
      markCodexSessionBackfillMarkerNeedsFullScan(paths.markerPath, newFullScanRequest)
    }
    // Persist launch debt so force-quit recovery resumes the bounded walk.
    const markerOwesFullScan = markCodexSessionBackfillMarkerPending(
      paths.markerPath,
      paths.systemSessionsRoot
    )
    // Carry durable full-scan demand across restarts.
    this.pendingHostSystemDefaultSessionMigrationNeedsFullScan ||= markerOwesFullScan
    return this.pendingHostSystemDefaultSessionMigrationNeedsFullScan
  }

  finishHostSystemDefaultSessionMigrationPass(): void {
    this.hostSystemDefaultSessionMigrationPending = false
    this.pendingHostSystemDefaultSessionMigrationNeedsFullScan = false
    this.pendingHostSystemDefaultSessionMigrationTarget = null
  }
}
