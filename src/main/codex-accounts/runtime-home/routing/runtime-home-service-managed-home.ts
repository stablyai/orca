import { statSync } from 'node:fs'
import { join } from 'node:path'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import {
  syncSystemCodexResourcesIntoManagedHome,
  getSystemCodexHomePath
} from '../../../codex/configuration/homes/codex-home-paths'
import { syncSystemConfigIntoManagedCodexHome } from '../../../codex/configuration/settings/codex-config-mirror'
import { CodexAccountHistoryPasses } from '../../../codex/history/shared-store/codex-account-history-passes'
import { isCodexHistorySharedAcrossAccounts } from './codex-history-sharing'
import { resolveHostCodexSessionSourceHome } from '../../../codex/history/rollouts/codex-session-source-home'
import { parseWslUncPath } from '../../../../shared/file-access/wsl-paths'
import { normalizeRuntimePathForComparison } from '../../../../shared/file-access/cross-platform-path'
import { normalizeCodexRuntimeSelection } from '../../account-management/runtime-selection'
import {
  resolveHostCodexManagedHomeVerdict,
  ManagedCodexHomeTemporarilyUnavailableError
} from '../../managed-homes/host-codex-managed-home-ownership'
import { hasCustomCodexHomeOverrideForLaunch } from '../../../codex/configuration/homes/codex-real-home-path'
import { resolveCodexSessionBackfillPaths } from '../../../codex/history/backfill/codex-session-backfill'
import {
  hasCompletedCodexSessionBackfillMarker,
  markCodexSessionBackfillMarkerNeedsFullScan
} from '../../../codex/history/backfill/codex-session-backfill-marker'
import { getDefaultWslDistro } from '../../../wsl/discovery/distro-catalog'
import { WslCodexAccountHistoryLaunches } from '../../../codex/history/shared-store/wsl-codex-account-history'
import type { CodexAccountSelectionTarget } from '../../../../shared/agent-accounts/codex/codex-selection-lane'
import type { CodexManagedAccount } from '../../../../shared/agent-accounts/managed-account-types'
import { CodexRuntimeHomeSync } from '../runtime-home-service-sync'

export abstract class CodexRuntimeHomeManagedHome extends CodexRuntimeHomeSync {
  private readonly accountHistoryPasses = new CodexAccountHistoryPasses()
  private readonly wslAccountHistory = new WslCodexAccountHistoryLaunches()

  // Host accounts refresh auth in separate homes so concurrent accounts cannot race one auth.json.
  protected getSelfContainedManagedHostAccount(): CodexManagedAccount | null {
    const settings = this.store.getSettings()
    const account = this.getActiveAccount(
      settings.codexManagedAccounts,
      normalizeCodexRuntimeSelection(settings).host
    )
    if (!account || this.getWslManagedHomePath(account)) {
      return null
    }
    return account
  }

  protected getManagedAccountHomesForSessionDiscovery(): string[] {
    const settings = this.store.getSettings()
    const homes: string[] = []
    let hostAccountsRootMissing: boolean | undefined
    for (const account of settings.codexManagedAccounts) {
      const wslHome = this.getWslManagedHomePath(account)
      if (wslHome) {
        homes.push(wslHome)
        continue
      }
      // A missing accounts root makes per-account ownership reads and warnings unnecessary.
      hostAccountsRootMissing ??= this.isManagedAccountsRootDefinitivelyAbsent()
      if (hostAccountsRootMissing) {
        continue
      }
      const trustedHome = this.getTrustedSelfContainedManagedHomePath(account)
      if (trustedHome) {
        homes.push(trustedHome)
      }
    }
    return homes
  }

  private isManagedAccountsRootDefinitivelyAbsent(): boolean {
    try {
      statSync(this.getManagedAccountsRoot())
      return false
    } catch (error) {
      // Any other read error stays with the ownership check, which reports it as indeterminate.
      return isDefinitiveAbsence(error)
    }
  }

  protected getManagedHostAccountHomesForSessionDiscovery(): string[] {
    const settings = this.store.getSettings()
    const homes: string[] = []
    for (const account of settings.codexManagedAccounts) {
      if (this.getWslManagedHomePath(account)) {
        continue
      }
      const trustedHome = this.getTrustedSelfContainedManagedHomePath(account)
      if (trustedHome) {
        homes.push(trustedHome)
      }
    }
    return homes
  }

  protected prepareSelfContainedManagedHomeForLaunch(
    account: CodexManagedAccount,
    unavailableManagedHomePath?: string,
    deferConfigSync?: (syncConfig: () => boolean) => void
  ): string | null {
    const resolved = this.resolveSelfContainedManagedHome(account)
    if (resolved.kind === 'indeterminate') {
      // Refuse launch without switching accounts behind a UI that still shows this selection.
      throw new ManagedCodexHomeTemporarilyUnavailableError()
    }
    if (resolved.kind === 'untrusted') {
      this.clearSelfContainedManagedSelection(account)
      return null
    }
    const perAccountHome = resolved.homePath
    if (
      unavailableManagedHomePath &&
      normalizeRuntimePathForComparison(unavailableManagedHomePath) ===
        normalizeRuntimePathForComparison(perAccountHome)
    ) {
      const absence = this.credentialAbsenceGrace.assess(join(perAccountHome, 'auth.json'))
      if (absence.state !== 'present' && absence.durable) {
        this.clearSelfContainedManagedSelection(account, 'credential remained unavailable')
        return null
      }
      // Allow auth rotation to settle; Codex re-reads the file after launch.
    }
    // Materialize resources and config in this home; the launch caller installs hooks and trust.
    this.lastSyncedAccountId = account.id
    this.lastHostAccountUsedSelfContainedHome = true
    this.sharedAuthRefreshBlockedByManagedTransition = true
    this.markSharedRuntimeAuthManaged(account.id)
    syncSystemCodexResourcesIntoManagedHome(perAccountHome)
    const syncConfig = (): boolean =>
      syncSystemConfigIntoManagedCodexHome({
        runtimeHomePath: perAccountHome,
        systemHomePath: getSystemCodexHomePath()
      })
    if (deferConfigSync) {
      deferConfigSync(syncConfig)
    } else {
      syncConfig()
    }
    return perAccountHome
  }

  /** Links this home's history into ~/.codex (fresh private folders when sharing is off). */
  prepareAccountHistory(accountHome: string, options: { forLaunch?: boolean } = {}): Promise<void> {
    return this.accountHistoryPasses.run(
      accountHome,
      isCodexHistorySharedAcrossAccounts(this.store.getSettings()),
      options
    )
  }

  /** Brings every trusted host account's history into the store without waiting for its launch. */
  protected prepareAllAccountHistoryInBackground(): void {
    for (const home of this.getManagedHostAccountHomesForSessionDiscovery()) {
      void this.prepareAccountHistory(home)
    }
  }

  /**
   * For launches pinned to a home other than the selected account's, such as a resume. Only
   * shares: provenance chose this home for a transcript that unsharing would move out of reach.
   */
  async prepareAccountHistoryForPinnedHome(home: string): Promise<void> {
    if (!isCodexHistorySharedAcrossAccounts(this.store.getSettings())) {
      return
    }
    const key = normalizeRuntimePathForComparison(home)
    const accountHome = this.getManagedHostAccountHomesForSessionDiscovery().find(
      (candidate) => normalizeRuntimePathForComparison(candidate) === key
    )
    if (accountHome) {
      await this.prepareAccountHistory(accountHome, { forLaunch: true })
    }
  }

  // Reading a distro's history over 9P would boot it (E9); the WSL lane owns those homes.
  protected isHostHistorySourceInWsl(): boolean {
    // The home the lanes actually read: the setting, else the system home they fall back to.
    const sourceHome =
      resolveHostCodexSessionSourceHome(this.store.getSettings()) ?? getSystemCodexHomePath()
    return parseWslUncPath(sourceHome) !== null
  }

  // Per-account homes own auth refreshes in place; selection needs no shared-mirror read-back.
  protected syncSelfContainedManagedSelection(account: CodexManagedAccount): void {
    const resolved = this.resolveSelfContainedManagedHome(account)
    if (resolved.kind === 'indeterminate') {
      // Transient read failures must preserve selection (#STA-4422).
      return
    }
    const perAccountHome = resolved.kind === 'owned' ? resolved.homePath : null
    if (perAccountHome) {
      this.lastSyncedAccountId = account.id
      this.lastHostAccountUsedSelfContainedHome = true
      this.sharedAuthRefreshBlockedByManagedTransition = true
      this.markSharedRuntimeAuthManaged(account.id)
      // Link history at selection so the next launch finds it done.
      void this.prepareAccountHistory(perAccountHome)
      return
    }
    this.clearSelfContainedManagedSelection(account)
  }

  /** Only `untrusted` permits deselection; `indeterminate` must preserve durable state. */
  protected resolveSelfContainedManagedHome(
    account: CodexManagedAccount
  ): { kind: 'owned'; homePath: string } | { kind: 'untrusted' } | { kind: 'indeterminate' } {
    const verdict = resolveHostCodexManagedHomeVerdict({
      candidatePath: account.managedHomePath,
      managedAccountsRoot: this.getManagedAccountsRoot(),
      systemCodexHomePath: getSystemCodexHomePath(),
      expectedAccountId: account.id
    })
    if (verdict.kind === 'owned') {
      // Keep persisted spelling (such as /var on macOS) so injected CODEX_HOME remains stable.
      return { kind: 'owned', homePath: account.managedHomePath }
    }
    if (verdict.kind === 'untrusted') {
      console.warn('[codex-runtime-home] Refusing untrusted managed account home:', verdict.reason)
      return { kind: 'untrusted' }
    }
    console.warn(
      '[codex-runtime-home] Managed account home is temporarily unreadable; keeping selection:',
      verdict.error
    )
    return { kind: 'indeterminate' }
  }

  /** Read-only callers that mutate nothing and simply skip an unusable home. */
  protected getTrustedSelfContainedManagedHomePath(account: CodexManagedAccount): string | null {
    const resolved = this.resolveSelfContainedManagedHome(account)
    return resolved.kind === 'owned' ? resolved.homePath : null
  }

  protected clearSelfContainedManagedSelection(
    account: CodexManagedAccount,
    reason = 'home is invalid'
  ): void {
    console.warn(`[codex-runtime-home] Active managed account ${reason}, clearing selection`)
    const settings = this.store.getSettings()
    if (normalizeCodexRuntimeSelection(settings).host !== account.id) {
      return
    }
    this.store.updateSettings({
      activeCodexManagedAccountId: null,
      activeCodexManagedAccountIdsByRuntime: {
        ...normalizeCodexRuntimeSelection(settings),
        host: null
      }
    })
    this.lastSyncedAccountId = null
    this.lastHostAccountUsedSelfContainedHome = false
  }

  protected invalidateBackfillAfterManagedSystemDefaultLaunch(
    launchEnv?: NodeJS.ProcessEnv
  ): boolean | null {
    const settings = this.store.getSettings()
    if (
      normalizeCodexRuntimeSelection(settings).host !== null ||
      hasCustomCodexHomeOverrideForLaunch(launchEnv)
    ) {
      return null
    }
    if (this.isHostHistorySourceInWsl()) {
      // This launch's dates go unrecorded, so a later plain source must walk all history.
      markCodexSessionBackfillMarkerNeedsFullScan(
        resolveCodexSessionBackfillPaths().markerPath,
        true
      )
      return null
    }
    if (!this.hostSystemDefaultSessionMigrationPending) {
      const paths = resolveCodexSessionBackfillPaths(
        resolveHostCodexSessionSourceHome(this.store.getSettings())
      )
      this.pendingHostSystemDefaultSessionMigrationNeedsFullScan =
        !hasCompletedCodexSessionBackfillMarker(paths.markerPath, paths.systemSessionsRoot)
      this.pendingHostSystemDefaultSessionMigrationTarget = normalizeRuntimePathForComparison(
        paths.systemSessionsRoot
      )
      this.hostSystemDefaultSessionMigrationPending = true
    }
    return this.prepareHostSystemDefaultSessionMigrationPass()
  }

  // Inside the distro its ~/.codex is the store; host and guest stores stay separate.
  /** The launched WSL account home's pass is awaited, ahead of the distro's other homes. */
  protected prepareWslAccountHistory(
    target: CodexAccountSelectionTarget,
    runtimeHomePath: string | null
  ): Promise<void> {
    if (process.platform !== 'win32' || !runtimeHomePath) {
      return Promise.resolve()
    }
    const distro =
      target.wslDistro?.trim() || parseWslUncPath(runtimeHomePath)?.distro || getDefaultWslDistro()
    const storeHome = distro
      ? this.getWslSystemCodexHomePath({ runtime: 'wsl', wslDistro: distro })
      : null
    if (!distro || !storeHome) {
      return Promise.resolve()
    }
    const linuxPathOf = (home: string): string => parseWslUncPath(home)?.linuxPath ?? home
    const launched = linuxPathOf(runtimeHomePath)
    const run = (accountHome: string, forLaunch: boolean): Promise<void> =>
      this.wslAccountHistory.run(
        {
          distro,
          accountHome,
          storeHome: linuxPathOf(storeHome),
          shared: isCodexHistorySharedAcrossAccounts(this.store.getSettings())
        },
        { forLaunch }
      )
    const accountHomes = this.store
      .getSettings()
      .codexManagedAccounts.flatMap(
        (account) => this.getWslLaunchCodexHomePath(account, distro) ?? []
      )
      .map(linuxPathOf)
    // The launched home first: the launch waits for it, never for its siblings' migrations.
    const launch = accountHomes.includes(launched) ? run(launched, true) : Promise.resolve()
    for (const home of accountHomes.filter((candidate) => candidate !== launched)) {
      void run(home, false)
    }
    return launch
  }
}
