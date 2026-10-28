import { statSync } from 'node:fs'
import { join } from 'node:path'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import {
  syncSystemCodexResourcesIntoManagedHome,
  getSystemCodexHomePath,
  resolveOrcaManagedCodexHomePath
} from '../codex/codex-home-paths'
import { syncSystemConfigIntoManagedCodexHome } from '../codex/codex-config-mirror'
import { startCodexAccountSessionBridgeInBackground } from '../codex/codex-account-session-bridge'
import {
  resolveHostCodexSessionSourceHome,
  resolveWslCodexSessionSourceHome
} from '../codex/codex-session-source-home'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { normalizeCodexRuntimeSelection } from './runtime-selection'
import {
  resolveHostCodexManagedHomeVerdict,
  ManagedCodexHomeTemporarilyUnavailableError
} from './host-codex-managed-home-ownership'
import { hasCustomCodexHomeOverrideForLaunch } from '../codex/codex-real-home-path'
import { resolveCodexSessionBackfillPaths } from '../codex/codex-session-backfill'
import { hasCompletedCodexSessionBackfillMarker } from '../codex/codex-session-backfill-marker'
import { getDefaultWslDistro } from '../wsl'
import { startWslCodexSessionBridgeInBackground } from '../codex/wsl-codex-session-bridge'
import type { CodexAccountSelectionTarget } from './runtime-selection'
import type { CodexManagedAccount } from '../../shared/managed-account-types'
import { CodexRuntimeHomeSync } from './runtime-home-service-sync'

export abstract class CodexRuntimeHomeManagedHome extends CodexRuntimeHomeSync {
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
    unavailableManagedHomePath?: string
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
    syncSystemConfigIntoManagedCodexHome({
      runtimeHomePath: perAccountHome,
      systemHomePath: getSystemCodexHomePath()
    })
    this.startSelfContainedSessionBridgeForLaunch(perAccountHome)
    return perAccountHome
  }

  // Bridge history in the background: /resume only sees launch-home rollouts, and scans can be large.
  protected startSelfContainedSessionBridgeForLaunch(perAccountHome: string): void {
    void startCodexAccountSessionBridgeInBackground({
      targetCodexHomePath: perAccountHome,
      sourceCodexHomePaths: this.getSelfContainedSessionBridgeSourceHomes()
    })
  }

  protected getSelfContainedSessionBridgeSourceHomes(): string[] {
    return [
      // Honor custom history sources without changing credential routing.
      resolveHostCodexSessionSourceHome(this.store.getSettings()) ?? getSystemCodexHomePath(),
      // Resolve the mirror path without creating it for per-account launches.
      resolveOrcaManagedCodexHomePath(),
      ...this.getManagedHostAccountHomesForSessionDiscovery()
    ]
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
      // Start history bridging at selection so /resume is ready before the next launch.
      this.startSelfContainedSessionBridgeForLaunch(perAccountHome)
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

  protected startWslSessionBridgeForLaunch(
    target: CodexAccountSelectionTarget,
    runtimeHomePath: string | null
  ): void {
    if (process.platform !== 'win32' || !runtimeHomePath) {
      return
    }
    const runtimeHomeWsl = parseWslUncPath(runtimeHomePath)
    const distro = target.wslDistro?.trim() || runtimeHomeWsl?.distro || getDefaultWslDistro()
    if (!distro) {
      return
    }
    // Honor custom WSL history sources without changing credential routing.
    const systemCodexHomePath =
      resolveWslCodexSessionSourceHome(this.store.getSettings(), distro) ??
      this.getWslSystemCodexHomePath({ runtime: 'wsl', wslDistro: distro })
    if (systemCodexHomePath && systemCodexHomePath !== runtimeHomePath) {
      // Create history links inside the distro so Codex can see them in /resume.
      void startWslCodexSessionBridgeInBackground({
        distro,
        systemCodexHomePath,
        managedCodexHomePath: runtimeHomePath
      })
    }
  }
}
