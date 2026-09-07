import { resolveHostCodexSessionSourceHome } from '../codex/codex-session-source-home'
import { startSystemCodexSessionBridgeInBackground } from '../codex/codex-session-bridge'
import { syncSystemCodexResourcesIntoManagedHome } from '../codex/codex-home-paths'
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
import { CodexRuntimeHomeRouting } from './runtime-home-service-home-routing'

export abstract class CodexRuntimeHomeLaunch extends CodexRuntimeHomeRouting {
  protected initializeLastSyncedState(): void {
    const settings = this.store.getSettings()
    const activeAccount = this.getActiveAccount(
      settings.codexManagedAccounts,
      normalizeCodexRuntimeSelection(settings).host
    )
    // Why: WSL-managed homes never touch host ~/.codex; treating one as "last synced" makes cold start mangle host auth Orca never touched.
    this.lastSyncedAccountId = this.getWslManagedHomePath(activeAccount)
      ? null
      : normalizeCodexRuntimeSelection(settings).host
  }

  /**
   * Materializes the runtime home needed before launching the CLI.
   *
   * Historical session bridging is requested in the background so launch setup
   * returns as soon as the active runtime home is ready.
   */
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
      // Why: only an untrusted home clears the selection; fall through to the
      // system default without injecting a path Orca cannot prove it owns.
    }
    if (this.isHostSystemDefaultRealHome(launchEnv)) {
      // Why: the system default runs Codex on the user's own ~/.codex.
      // Returning null tells the PTY/env layer to inject no managed CODEX_HOME;
      // the retired mirror is refreshed only for pre-rollout PTYs.
      this.reconcileLegacySharedHomeForRetainedPanes()
      return null
    }
    this.invalidateBackfillAfterManagedSystemDefaultLaunch(launchEnv)
    this.syncForCurrentSelection(target, launchEnv)
    syncSystemCodexResourcesIntoManagedHome()
    syncSystemConfigIntoManagedCodexHome()
    // Why: sessions can be large; bridge them after launch so starting a fresh TUI never waits on a full tree walk.
    void startSystemCodexSessionBridgeInBackground(
      {},
      resolveHostCodexSessionSourceHome(this.store.getSettings())
    )
    return this.getRuntimeHomePath()
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
    // Why: the retired home may hold the freshest credential, so the first
    // direct-home Codex spawn must wait for its bounded guest transaction.
    await this.startLegacyWslAuthDrain(wslTarget, { throwOnFailure: true })
    this.finishWslLaunchPreparation(wslTarget, homePath)
    return homePath
  }

  beginHostSystemDefaultSessionMigrationLaunch(
    codexHomePath: string | null,
    options: { reattached?: boolean; launchEnv?: NodeJS.ProcessEnv } = {}
  ): boolean | null {
    if (
      !this.isHostSystemDefaultSessionMigrationEligible() ||
      (!codexHomePath && !options.reattached) ||
      (codexHomePath &&
        normalizeRuntimePathForComparison(codexHomePath) !==
          normalizeRuntimePathForComparison(this.getRuntimeHomePath()))
    ) {
      return null
    }
    // Why: an older pass can clear launch preparation while PTY spawn awaits recovery.
    return this.invalidateBackfillAfterManagedSystemDefaultLaunch(
      options.reattached && !codexHomePath ? undefined : options.launchEnv
    )
  }

  isHostSystemDefaultSessionMigrationEligible(): boolean {
    return (
      normalizeCodexRuntimeSelection(this.store.getSettings()).host === null &&
      !hasCustomCodexHomeOverrideForLaunch()
    )
  }

  prepareHostSystemDefaultSessionMigrationPass(
    scanDates: readonly CodexSessionBackfillDate[] = []
  ): boolean {
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
    // Why: the launch creates rollouts for these dates; record them durably so a
    // force-quit recovers a bounded window instead of re-walking all history.
    const markerOwesFullScan = markCodexSessionBackfillMarkerPending(
      paths.markerPath,
      paths.systemSessionsRoot,
      scanDates.length > 0 ? scanDates : [getCodexSessionBackfillDate()]
    )
    // Why: the marker is the only place an overflowed pending window survives a
    // restart, so its demand has to reach this pass rather than die in the file.
    this.pendingHostSystemDefaultSessionMigrationNeedsFullScan ||= markerOwesFullScan
    return this.pendingHostSystemDefaultSessionMigrationNeedsFullScan
  }

  finishHostSystemDefaultSessionMigrationPass(): void {
    this.hostSystemDefaultSessionMigrationPending = false
    this.pendingHostSystemDefaultSessionMigrationNeedsFullScan = false
    this.pendingHostSystemDefaultSessionMigrationTarget = null
  }
}
