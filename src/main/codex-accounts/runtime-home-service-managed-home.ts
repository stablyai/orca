import { join } from 'node:path'
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
  // Why: a managed HOST account runs against its own self-contained CODEX_HOME
  // (codex-accounts/<id>/home) rather than the shared runtime mirror. Its
  // auth.json lives there and codex refreshes it in place, so two accounts never
  // race one auth.json. WSL accounts keep their per-distro lane.
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

  // Why: session discovery must surface every account's own rollouts wherever they live.
  protected getManagedAccountHomesForSessionDiscovery(): string[] {
    const settings = this.store.getSettings()
    const homes: string[] = []
    for (const account of settings.codexManagedAccounts) {
      const wslHome = this.getWslManagedHomePath(account)
      if (wslHome) {
        homes.push(wslHome)
        continue
      }
      const trustedHome = this.getTrustedSelfContainedManagedHomePath(account)
      if (trustedHome) {
        homes.push(trustedHome)
      }
    }
    return homes
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
      // Why: refuse the launch rather than silently falling through to the
      // system default, which would run a different account behind a UI still
      // showing this one. The selection stays put; a later read may succeed.
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
      // Why: a transient missing/unreadable auth.json is usually codex rotating
      // it; keep the selection and launch — the CLI re-reads the settled file.
    }
    // Why: link the user's real ~/.codex resources and mirror config into THIS
    // home (never symlinking into or mutating ~/.codex), so the per-account home
    // is a complete CODEX_HOME. Hooks/trust are installed by the launch caller.
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

  // Why: Codex's own `/resume` picker only lists rollouts under the launch
  // CODEX_HOME, so a self-contained account home starts out with no history at
  // all. Hardlink every other Orca-visible home's rollouts in — after launch,
  // since history trees can be large — so switching accounts no longer hides
  // the user's conversations.
  protected startSelfContainedSessionBridgeForLaunch(perAccountHome: string): void {
    void startCodexAccountSessionBridgeInBackground({
      targetCodexHomePath: perAccountHome,
      sourceCodexHomePaths: this.getSelfContainedSessionBridgeSourceHomes()
    })
  }

  protected getSelfContainedSessionBridgeSourceHomes(): string[] {
    return [
      // Why: history-only override lets custom-CODEX_HOME users bridge from the
      // home they actually record sessions in; falls back to the real ~/.codex.
      resolveHostCodexSessionSourceHome(this.store.getSettings()) ?? getSystemCodexHomePath(),
      // Why: path only — a per-account install must not materialize the mirror.
      resolveOrcaManagedCodexHomePath(),
      ...this.getManagedHostAccountHomesForSessionDiscovery()
    ]
  }

  // Why: the per-account home is both the launch CODEX_HOME and the credential
  // store, so codex reads/refreshes auth.json in place — there is no shared-home
  // hot-swap or token read-back to reconcile. A trusted home remains selected
  // while Codex atomically replaces auth.json.
  protected syncSelfContainedManagedSelection(account: CodexManagedAccount): void {
    const resolved = this.resolveSelfContainedManagedHome(account)
    if (resolved.kind === 'indeterminate') {
      // Why: a sync runs on every app start, exactly when antivirus is busiest.
      // An unreadable home must not deselect the account (#STA-4422).
      return
    }
    const perAccountHome = resolved.kind === 'owned' ? resolved.homePath : null
    if (perAccountHome) {
      this.lastSyncedAccountId = account.id
      this.lastHostAccountUsedSelfContainedHome = true
      this.sharedAuthRefreshBlockedByManagedTransition = true
      this.markSharedRuntimeAuthManaged(account.id)
      // Why: selection runs well before the user restarts a pane, so history is
      // already linked in by the time the newly launched Codex opens /resume.
      this.startSelfContainedSessionBridgeForLaunch(perAccountHome)
      return
    }
    this.clearSelfContainedManagedSelection(account)
  }

  /**
   * Why: an unreadable home and an untrustworthy one demand opposite responses.
   * Only `untrusted` may clear the user's selection; `indeterminate` means we
   * could not tell, so callers refuse the operation and leave durable state
   * alone (#STA-4422).
   */
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
      // Preserve the persisted path spelling (notably /var vs /private/var on
      // macOS) so injected CODEX_HOME stays stable across the rollout.
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
    // Why: history-only override lets custom-CODEX_HOME users bridge from their real home; falls back to <wslHome>/.codex.
    const systemCodexHomePath =
      resolveWslCodexSessionSourceHome(this.store.getSettings(), distro) ??
      this.getWslSystemCodexHomePath({ runtime: 'wsl', wslDistro: distro })
    if (systemCodexHomePath && systemCodexHomePath !== runtimeHomePath) {
      // Why: WSL history must be hardlinked inside the distro; host-side links can't bridge Windows and WSL filesystems in a resume-visible way.
      void startWslCodexSessionBridgeInBackground({
        distro,
        systemCodexHomePath,
        managedCodexHomePath: runtimeHomePath
      })
    }
  }
}
