import { prepareCodexLaunchHome } from '../codex/codex-legacy-session-resume'
import { resolveCodexLaunchHome } from '../codex/codex-launch-home'
import { getSystemCodexHomePath } from '../codex/codex-home-paths'
import { resolveHostCodexSessionSourceHome } from '../codex/codex-session-source-home'
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
    options?: {
      unavailableManagedHomePath?: string
      conversationHome?: string
      transcriptPath?: string
    }
  ): string | null {
    if (target?.runtime === 'wsl') {
      const wslTarget = this.resolveWslDefaultTarget(target)
      const homePath = this.getWslCodexHomePathForSelection(wslTarget)
      this.startLegacyWslAuthDrain(wslTarget)
      this.finishWslLaunchPreparation(wslTarget, homePath)
      return homePath
    }
    return (
      resolveCodexLaunchHome(this.prepareHostLaunchOptions(options)) ??
      (hasCustomCodexHomeOverrideForLaunch(launchEnv) ? getSystemCodexHomePath() : null)
    )
  }

  private prepareHostLaunchOptions(options?: {
    unavailableManagedHomePath?: string
    conversationHome?: string
    transcriptPath?: string
  }) {
    const account = this.getSelfContainedManagedHostAccount()
    const loginHome = account
      ? this.prepareSelfContainedManagedHomeForLaunch(account, options?.unavailableManagedHomePath)
      : null
    if (!account) {
      this.copyMirrorLoginIntoEmptySystemHome()
      this.reconcileLegacySharedHomeForRetainedPanes()
    }
    return {
      selectedAccount: loginHome ? { homePath: loginHome } : null,
      conversationHome: options?.conversationHome,
      transcriptPath: options?.transcriptPath,
      storeHome: resolveHostCodexSessionSourceHome(this.store.getSettings()),
      accountsRoot: this.getManagedAccountsRoot()
    }
  }

  /** Catalog reads and launches derive the same path; reads never materialize it. */
  resolveHostCodexHomePathForLaunchReadOnly(
    launchEnv?: NodeJS.ProcessEnv,
    conversationHome?: string
  ): string | null {
    const account = this.getSelfContainedManagedHostAccount()
    const resolved = account ? this.resolveSelfContainedManagedHome(account) : null
    if (resolved?.kind === 'indeterminate') {
      throw new ManagedCodexHomeTemporarilyUnavailableError()
    }
    return (
      resolveCodexLaunchHome({
        selectedAccount: resolved?.kind === 'owned' ? { homePath: resolved.homePath } : null,
        conversationHome,
        storeHome: resolveHostCodexSessionSourceHome(this.store.getSettings()),
        accountsRoot: this.getManagedAccountsRoot(),
        readOnly: true
      }) ?? (hasCustomCodexHomeOverrideForLaunch(launchEnv) ? getSystemCodexHomePath() : null)
    )
  }

  async prepareForCodexLaunchAsync(
    target?: CodexAccountSelectionTarget,
    launchEnv?: NodeJS.ProcessEnv,
    options?: {
      unavailableManagedHomePath?: string
      conversationHome?: string
      transcriptPath?: string
    }
  ): Promise<string | null> {
    if (target?.runtime !== 'wsl') {
      return (
        (await prepareCodexLaunchHome(this.prepareHostLaunchOptions(options))) ??
        (hasCustomCodexHomeOverrideForLaunch(launchEnv) ? getSystemCodexHomePath() : null)
      )
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
    void codexHomePath
    void options
    return null
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
