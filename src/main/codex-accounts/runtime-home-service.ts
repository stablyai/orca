/* eslint-disable max-lines -- Why: keeps Codex's whole runtime-home contract in one place so account-switch semantics don't drift across launch/login/quota paths. */
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import {
  dirname,
  extname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  win32 as pathWin32
} from 'node:path'
import { app } from 'electron'
import type { CodexManagedAccount } from '../../shared/types'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import type { Store } from '../persistence'
import { WSL_CODEX_RUNTIME_HOME_SEGMENTS } from '../pty/codex-home-wsl-env'
import {
  recoverInterruptedGuardedFileOperation,
  removeFileAtomicallyIfUnchanged,
  writeFileAtomically,
  writeFileAtomicallyIfUnchanged
} from './fs-utils'
import {
  getOrcaManagedCodexHomePath,
  getOrcaUserDataPath,
  getCodexSessionBackfillStateDirPath,
  getSystemCodexHomePath,
  resolveOrcaManagedCodexHomePath,
  syncCodexGlobalInstructionsIntoManagedHome,
  syncSystemCodexResourcesIntoManagedHome
} from '../codex/codex-home-paths'
import { startCodexAccountSessionBridgeInBackground } from '../codex/codex-account-session-bridge'
import { startSystemCodexSessionBridgeInBackground } from '../codex/codex-session-bridge'
import {
  resolveHostCodexSessionSourceHome,
  resolveWslCodexSessionSourceHome
} from '../codex/codex-session-source-home'
import { startWslCodexSessionBridgeInBackground } from '../codex/wsl-codex-session-bridge'
import {
  prepareSystemConfigForFreshRuntimeMirror,
  syncSystemConfigIntoManagedCodexHome
} from '../codex/codex-config-mirror'
import { parseWslUncPath } from '../../shared/wsl-paths'
import {
  getWslSelectionKey,
  getSelectedCodexAccountIdForTarget,
  normalizeCodexRuntimeSelection,
  setSelectedCodexAccountIdForTarget,
  type CodexAccountSelectionTarget
} from './runtime-selection'
import { getDefaultWslDistro, getWslHome } from '../wsl'
import { hasCustomCodexHomeOverrideForLaunch } from '../codex/codex-real-home-path'
import { invalidateCodexSessionBackfillMarker } from '../codex/codex-session-backfill-marker'
import { assertOwnedHostCodexManagedHomePath } from './host-codex-managed-home-ownership'
import {
  codexAuthCouldBelongToManagedAccount,
  codexAuthIsFresher,
  codexAuthMatchesManagedAccount,
  codexAuthMatchesSystemDefaultIdentity
} from './codex-auth-identity'
import { migrateLegacySharedAuthToPerAccountHome } from './legacy-shared-auth-migration'
import { CodexCredentialAbsenceGrace } from './codex-credential-absence-grace'
import { syncLegacySharedCodexConfigForRetainedPanes } from './legacy-shared-config-compatibility'
import {
  hasRecordedLegacySharedCodexPane,
  type CodexPaneHomeRoute
} from '../codex/codex-pane-account-registry'
import { isShellStartupEnvProbeSupported } from '../pty/shell-startup-env'

type CodexSystemDefaultSnapshot = {
  authJson: string | null
}

type CodexRuntimeLogoutMarker = {
  systemDefaultAuthJson: string | null
  loggedOutAt: number
}

type CodexSharedRuntimeAuthProvenance =
  | { owner: 'system-default'; authJson: string | null }
  | {
      owner: 'managed'
      accountId: string
      systemDefaultBaseline?: { authJson: string | null }
    }
type CodexSharedRuntimeAuthPendingProvenance = {
  owner: 'pending'
  next: CodexSharedRuntimeAuthProvenance
  runtimeAuthJson: string | null
}
type CodexSharedRuntimeAuthProvenanceFile =
  | CodexSharedRuntimeAuthProvenance
  | CodexSharedRuntimeAuthPendingProvenance
  | { owner: 'fenced' }
type CodexSharedRuntimeAuthProvenanceStatus =
  | { kind: 'missing' | 'fenced' }
  | { kind: 'committed'; provenance: CodexSharedRuntimeAuthProvenance }

type CodexRuntimeLogoutMarkerStatus =
  | { kind: 'missing' }
  | { kind: 'applies' }
  | { kind: 'system-default-changed'; systemDefaultAuthJson: string | null }

type CodexReadBackResult = 'unchanged' | 'persisted' | 'rejected'
type CodexReadBackMatch =
  | {
      kind: 'matched'
      account: CodexManagedAccount
      managedAuthPath: string
      managedAuthContents: string
    }
  | { kind: 'none' | 'ambiguous' }

function readCodexLastRefresh(authJson: string): number | null {
  try {
    const parsed = JSON.parse(authJson) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    const value = (parsed as Record<string, unknown>).last_refresh
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null
    }
    if (typeof value !== 'string' || !value.trim()) {
      return null
    }
    const timestamp = Date.parse(value)
    return Number.isFinite(timestamp) ? timestamp : null
  } catch {
    return null
  }
}

function codexAuthIsMonotonicallyFresher(
  candidateAuthJson: string,
  baselineAuthJson: string
): boolean {
  const candidateLastRefresh = readCodexLastRefresh(candidateAuthJson)
  const baselineLastRefresh = readCodexLastRefresh(baselineAuthJson)
  if (candidateLastRefresh !== null || baselineLastRefresh !== null) {
    return (
      candidateLastRefresh !== null &&
      baselineLastRefresh !== null &&
      candidateLastRefresh > baselineLastRefresh
    )
  }
  return codexAuthIsFresher(candidateAuthJson, baselineAuthJson)
}

export class CodexRuntimeHomeService {
  // Which managed account runtime auth.json mirrors; null means it follows system-default ~/.codex instead of a managed account.
  private lastSyncedAccountId: string | null = null
  // Last auth.json Orca wrote to the runtime home; a later diff signals an out-of-band change (Codex token refresh, or external login to adopt).
  private lastWrittenAuthJson: string | null = null
  // Why: WSL terminals have per-distro runtime homes; sharing the host baseline can make stale WSL auth look newer than managed storage.
  private readonly lastWrittenWslAuthJsonByDistro = new Map<string, string | null>()
  private readonly lastSyncedWslAccountIdByDistro = new Map<string, string | null>()
  private readonly wslRuntimeHomePathByDistro = new Map<string, string>()
  private skipNextReadBackForAccountId: string | null = null
  // Why: a managed host account refreshes auth in its own home. Remember that
  // provenance so a later deselect never adopts stale shared bytes.
  private lastHostAccountUsedSelfContainedHome = false
  private sharedAuthRefreshBlockedByManagedTransition = false
  // Why: transient auth.json read/parse failures must not deselect an account.
  private readonly credentialAbsenceGrace = new CodexCredentialAbsenceGrace()

  constructor(private readonly store: Store) {
    this.safeRecoverInterruptedRuntimeAuthOperation()
    this.safeMigrateLegacySharedAuth()
    this.safeMigrateLegacyManagedState()
    this.safeMigrateLegacyActiveHomePointer()
    this.initializeLastSyncedState()
    this.safeSyncForCurrentSelection()
  }

  private initializeLastSyncedState(): void {
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
      const syncedRuntimeHomePath = this.syncWslRuntimeForCurrentSelection(wslTarget)
      this.syncWslConfigAndGlobalInstructionsForLaunch(wslTarget, syncedRuntimeHomePath)
      const runtimeHomePath = syncedRuntimeHomePath ?? this.getWslSystemCodexHomePath(wslTarget)
      this.startWslSessionBridgeForLaunch(wslTarget, runtimeHomePath)
      return runtimeHomePath
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

  // Why: a managed HOST account runs against its own self-contained CODEX_HOME
  // (codex-accounts/<id>/home) rather than the shared runtime mirror. Its
  // auth.json lives there and codex refreshes it in place, so two accounts never
  // race one auth.json. WSL accounts keep their per-distro lane.
  private getSelfContainedManagedHostAccount(): CodexManagedAccount | null {
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

  // Why: session discovery must surface a managed account's own rollouts wherever
  // they physically live. Every host managed home is a live CODEX_HOME, so scan
  // them all.
  private getManagedHostAccountHomesForSessionDiscovery(): string[] {
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

  private prepareSelfContainedManagedHomeForLaunch(
    account: CodexManagedAccount,
    unavailableManagedHomePath?: string
  ): string | null {
    const perAccountHome = this.getTrustedSelfContainedManagedHomePath(account)
    if (!perAccountHome) {
      this.clearSelfContainedManagedSelection(account)
      return null
    }
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
  private startSelfContainedSessionBridgeForLaunch(perAccountHome: string): void {
    void startCodexAccountSessionBridgeInBackground({
      targetCodexHomePath: perAccountHome,
      sourceCodexHomePaths: this.getSelfContainedSessionBridgeSourceHomes()
    })
  }

  private getSelfContainedSessionBridgeSourceHomes(): string[] {
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
  private syncSelfContainedManagedSelection(account: CodexManagedAccount): void {
    const perAccountHome = this.getTrustedSelfContainedManagedHomePath(account)
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

  private getTrustedSelfContainedManagedHomePath(account: CodexManagedAccount): string | null {
    try {
      assertOwnedHostCodexManagedHomePath({
        candidatePath: account.managedHomePath,
        managedAccountsRoot: this.getManagedAccountsRoot(),
        systemCodexHomePath: getSystemCodexHomePath(),
        expectedAccountId: account.id
      })
      // Preserve the persisted path spelling (notably /var vs /private/var on
      // macOS) so injected CODEX_HOME stays stable across the rollout.
      return account.managedHomePath
    } catch (error) {
      console.warn('[codex-runtime-home] Refusing untrusted managed account home:', error)
      return null
    }
  }

  private clearSelfContainedManagedSelection(
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

  private invalidateBackfillAfterManagedSystemDefaultLaunch(launchEnv?: NodeJS.ProcessEnv): void {
    const settings = this.store.getSettings()
    if (normalizeCodexRuntimeSelection(settings).host !== null) {
      return
    }
    // Why: reached only when the real-home lane is selected but its gate is off,
    // so the launch runs on the mirror and the backfill marker is stale.
    if (this.isHostSystemDefaultRealHomeSelected(launchEnv)) {
      invalidateCodexSessionBackfillMarker(
        join(getCodexSessionBackfillStateDirPath(), 'backfill-complete.json')
      )
    }
  }

  private startWslSessionBridgeForLaunch(
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
    if (!systemCodexHomePath || systemCodexHomePath === runtimeHomePath) {
      return
    }
    // Why: WSL history must be hardlinked inside the distro; host-side links can't bridge Windows and WSL filesystems in a resume-visible way.
    void startWslCodexSessionBridgeInBackground({
      distro,
      systemCodexHomePath,
      managedCodexHomePath: runtimeHomePath
    })
  }

  getHostCodexHomePathsForSessionDiscovery(): string[] {
    const homes = [this.getRuntimeHomePath()]
    if (this.isHostSystemDefaultRealHome() || this.getSelfContainedManagedHostAccount()) {
      // Why: nested Orca processes can retain an ambient managed CODEX_HOME.
      // Per-account lanes no longer bridge real-home history into the shared
      // mirror, so include the real root for both directly-routed host lanes.
      homes.push(getSystemCodexHomePath())
    }
    // Why: each managed host account runs in its own self-contained home, so
    // its rollouts live there rather than in the shared mirror. Scan every such
    // home so account-scoped sessions still surface in the AI Vault.
    for (const perAccountHome of this.getManagedHostAccountHomesForSessionDiscovery()) {
      homes.push(perAccountHome)
    }
    return homes.filter((home, index) => homes.indexOf(home) === index)
  }

  /**
   * The account-owned CODEX_HOME the current HOST selection runs against, or
   * null when the selection is not routed to one (system default, or a WSL
   * account, whose home lives inside the distro).
   *
   * Read-only on purpose: session discovery ranks homes with this before any
   * launch prep, so it must create no directories and sync no auth.
   */
  getSelectedHostAccountCodexHomePath(): string | null {
    const selfContainedAccount = this.getSelfContainedManagedHostAccount()
    return selfContainedAccount
      ? this.getTrustedSelfContainedManagedHomePath(selfContainedAccount)
      : null
  }

  getSelectedHostCodexHomeRoute(): CodexPaneHomeRoute {
    if (this.getSelfContainedManagedHostAccount()) {
      return 'account-home'
    }
    return this.isHostSystemDefaultRealHome() ? 'real-home' : 'shared-home'
  }

  // Why: the real-home hook installer flips this gate off when the trust-grant
  // client reports the host incapable, keeping that host byte-identical to the
  // managed lane instead of shipping status-blind panes.
  private realHomeLaneGate: () => boolean = () => true

  setRealHomeLaneGate(gate: () => boolean): void {
    this.realHomeLaneGate = gate
  }

  // Why: real-home routing applies only to the host system-default selection.
  // Managed accounts run in their own homes; Windows (no shell-startup probe)
  // and custom CODEX_HOMEs stay on the mirror until cleanup can be tracked
  // across old homes.
  isHostSystemDefaultRealHomeSelected(launchEnv?: NodeJS.ProcessEnv): boolean {
    const settings = this.store.getSettings()
    if (
      normalizeCodexRuntimeSelection(settings).host !== null ||
      !isShellStartupEnvProbeSupported()
    ) {
      return false
    }
    return !hasCustomCodexHomeOverrideForLaunch(launchEnv)
  }

  isHostSystemDefaultRealHome(launchEnv?: NodeJS.ProcessEnv): boolean {
    return this.isHostSystemDefaultRealHomeSelected(launchEnv) && this.realHomeLaneGate()
  }

  reconcileLegacySharedHomeForRetainedPanes(): void {
    if (!this.isHostSystemDefaultRealHome() || !hasRecordedLegacySharedCodexPane()) {
      return
    }
    this.syncLegacySharedSystemDefaultAuthForRetainedPanes()
    syncLegacySharedCodexConfigForRetainedPanes()
  }

  syncActiveWslSelectionsBeforeRestart(): void {
    if (process.platform !== 'win32') {
      return
    }

    const settings = this.store.getSettings()
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
      this.safeReadBackActiveWslAccountBeforeRestart(account, selectedDistroKey)
    }
  }

  private getWslSystemCodexHomePath(target: CodexAccountSelectionTarget): string | null {
    if (process.platform !== 'win32') {
      return null
    }
    const distro = target.wslDistro?.trim() || getDefaultWslDistro()
    if (!distro) {
      return null
    }
    const home = getWslHome(distro)
    return home ? this.joinWslPath(home, '.codex') : null
  }

  private syncWslConfigAndGlobalInstructionsForLaunch(
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
    // Why: WSL uses a distro-local CODEX_HOME, so host resource mirroring can't provide the distro user's global instructions.
    syncCodexGlobalInstructionsIntoManagedHome({
      systemHomePath,
      managedHomePath: runtimeHomePath
    })
    syncSystemConfigIntoManagedCodexHome({ runtimeHomePath, systemHomePath })
  }

  prepareForRateLimitFetch(target?: CodexAccountSelectionTarget): string | null {
    if (target?.runtime === 'wsl') {
      const wslTarget = this.resolveWslDefaultTarget(target)
      const syncedRuntimeHomePath = this.getPreparedWslRateLimitHomePath(wslTarget)
      return syncedRuntimeHomePath ?? this.getWslSystemCodexHomePath(wslTarget)
    }
    const selfContainedAccount = this.getSelfContainedManagedHostAccount()
    const selfContainedHome = selfContainedAccount
      ? this.getTrustedSelfContainedManagedHomePath(selfContainedAccount)
      : null
    if (selfContainedAccount && selfContainedHome) {
      // Why: the quota fetch reads the account's own auth.json in place; no
      // shared-home hot-swap or per-poll resource relink (that is launch prep).
      return selfContainedHome
    }
    if (selfContainedAccount) {
      this.clearSelfContainedManagedSelection(selfContainedAccount)
    }
    if (this.isHostSystemDefaultRealHome()) {
      // Why: null lets the fetcher fall back to the main process's inherited
      // CODEX_HOME before ~/.codex. Nested Orca launches can inherit the
      // managed home, restarting the background OAuth conflict (#5370), so
      // pin this non-interactive lane to the native home explicitly.
      if (hasRecordedLegacySharedCodexPane()) {
        this.syncLegacySharedSystemDefaultAuthForRetainedPanes()
      }
      return getSystemCodexHomePath()
    }
    this.syncForCurrentSelection()
    syncSystemCodexResourcesIntoManagedHome()
    syncSystemConfigIntoManagedCodexHome()
    return this.getRuntimeHomePath()
  }

  syncForCurrentSelection(
    target?: CodexAccountSelectionTarget,
    launchEnv?: NodeJS.ProcessEnv
  ): void {
    if (target?.runtime === 'wsl') {
      this.syncWslRuntimeForCurrentSelection(target)
      return
    }

    const selfContainedAccount = this.getSelfContainedManagedHostAccount()
    if (selfContainedAccount) {
      // Why: self-contained managed homes hold their own auth, so the shared
      // runtime home's snapshot/hot-swap/read-back machinery below must not run.
      this.syncSelfContainedManagedSelection(selfContainedAccount)
      return
    }
    const settings = this.store.getSettings()
    if (this.lastHostAccountUsedSelfContainedHome) {
      // Why: the account's auth is already canonical in its own home. Reset the
      // legacy mirror baseline without reading it; a real-home deselect needs no
      // further sync, and the mirror lane below re-seeds from canonical storage.
      this.lastHostAccountUsedSelfContainedHome = false
      this.lastSyncedAccountId = null
      this.lastWrittenAuthJson = null
      if (this.isHostSystemDefaultRealHome(launchEnv)) {
        return
      }
    }
    if (this.isHostSystemDefaultRealHome(launchEnv)) {
      // Why: retained daemon panes may own shared auth from a managed launch;
      // compatibility reconciliation runs later with durable provenance.
      if (this.lastSyncedAccountId !== null) {
        this.sharedAuthRefreshBlockedByManagedTransition = true
        this.lastSyncedAccountId = null
        this.lastWrittenAuthJson = null
      }
      return
    }
    const runtimeAuthExistedBeforeSync = existsSync(this.getRuntimeAuthPath())
    if (this.lastSyncedAccountId === null) {
      this.captureSystemDefaultSnapshot({ force: false })
    }
    const activeAccount = this.getActiveAccount(
      settings.codexManagedAccounts,
      normalizeCodexRuntimeSelection(settings).host
    )
    if (activeAccount) {
      // Why: only a WSL-managed account can reach here — every host account was
      // routed to its own self-contained home above. Its auth lives in the
      // distro-local runtime home, so the host mirror only drops its baseline.
      this.lastSyncedAccountId = null
      this.lastWrittenAuthJson = null
      this.skipNextReadBackForAccountId = null
      return
    }
    if (normalizeCodexRuntimeSelection(settings).host) {
      this.store.updateSettings({
        activeCodexManagedAccountId: null,
        activeCodexManagedAccountIdsByRuntime: {
          ...normalizeCodexRuntimeSelection(settings),
          host: null
        }
      })
    }
    // Why: only restore the system-default mirror when leaving a managed account; otherwise later syncs mirror current ~/.codex instead of replaying an old snapshot.
    if (this.lastSyncedAccountId !== null) {
      this.restoreSystemDefaultSnapshot({ detectExternalLogin: true })
      this.lastSyncedAccountId = null
    } else if (!runtimeAuthExistedBeforeSync) {
      const logoutMarkerStatus = this.getRuntimeLogoutMarkerStatus()
      if (logoutMarkerStatus.kind === 'applies') {
        this.lastWrittenAuthJson = null
      } else if (
        logoutMarkerStatus.kind === 'system-default-changed' &&
        logoutMarkerStatus.systemDefaultAuthJson !== null
      ) {
        this.restoreSystemDefaultSnapshot({ detectExternalLogin: false })
      } else if (logoutMarkerStatus.kind === 'system-default-changed') {
        // Why: a real ~/.codex logout after a local runtime logout should keep runtime auth absent, not restore the stale snapshot.
        this.captureSystemDefaultSnapshot({ force: true })
        this.persistRuntimeLogoutMarker(null)
        this.lastWrittenAuthJson = null
      } else if (this.lastWrittenAuthJson === null) {
        // Why: unmanaged sessions use an Orca-owned CODEX_HOME; seed it once from system-default auth so terminals stay logged in without mutating ~/.codex.
        this.restoreSystemDefaultSnapshot({ detectExternalLogin: false })
      } else {
        this.persistRuntimeLogoutMarker()
      }
    } else {
      this.clearRuntimeLogoutMarker()
      this.syncRuntimeAuthWithSystemDefault()
    }
  }

  // Why: re-auth/add-account write fresh managed tokens, so skip the next read-back to avoid clobbering them with stale runtime tokens.
  clearLastWrittenAuthJson(
    accountId = normalizeCodexRuntimeSelection(this.store.getSettings()).host
  ): void {
    if (accountId === normalizeCodexRuntimeSelection(this.store.getSettings()).host) {
      this.lastWrittenAuthJson = null
    }
    this.skipNextReadBackForAccountId = accountId
  }

  private readBackRefreshedTokensFromPath(
    runtimeAuthPath: string,
    options: {
      updateLastWrittenAuthJson: boolean
      lastWrittenAuthJson?: string | null
      setLastWrittenAuthJson?: (contents: string) => void
      expectedAccountId?: string
    }
  ): CodexReadBackResult {
    try {
      if (!existsSync(runtimeAuthPath)) {
        return 'unchanged'
      }

      const lastWrittenAuthJson =
        options.lastWrittenAuthJson === undefined
          ? this.lastWrittenAuthJson
          : options.lastWrittenAuthJson
      const runtimeContents = readFileSync(runtimeAuthPath, 'utf-8')
      if (lastWrittenAuthJson !== null && runtimeContents === lastWrittenAuthJson) {
        return 'unchanged'
      }

      const match = this.findManagedAccountForRuntimeAuth(
        runtimeContents,
        options.expectedAccountId
      )
      if (match.kind !== 'matched') {
        if (match.kind === 'ambiguous') {
          console.warn('[codex-runtime-home] Refusing ambiguous Codex auth read-back')
        }
        return 'rejected'
      }
      // Why: after restart there's no last-written baseline, so identity alone can't prove runtime auth is newer than managed storage.
      if (
        lastWrittenAuthJson === null &&
        !this.runtimeAuthIsFresher(runtimeContents, match.managedAuthContents)
      ) {
        return 'rejected'
      }

      writeFileAtomically(match.managedAuthPath, runtimeContents, { mode: 0o600 })
      if (options.updateLastWrittenAuthJson) {
        if (options.setLastWrittenAuthJson) {
          options.setLastWrittenAuthJson(runtimeContents)
        } else {
          this.lastWrittenAuthJson = runtimeContents
        }
      }
      return 'persisted'
    } catch (error) {
      // Why: read-back is best-effort; a transient fs error must not block the forward sync — worst case is one more stale-token cycle.
      console.warn('[codex-runtime-home] Failed to read back refreshed tokens:', error)
      return 'rejected'
    }
  }

  // Why: which ~/.codex bytes the mirror was seeded from, and whether the system
  // default can be proven to own the mirror at all.
  private resolveSystemDefaultMirrorClaim(
    runtimeAuth: string,
    provenanceStatus: CodexSharedRuntimeAuthProvenanceStatus
  ): { ownershipProven: boolean; mirroredAuthJson: string | null } {
    const provenance = provenanceStatus.kind === 'committed' ? provenanceStatus.provenance : null
    const snapshotAuth =
      this.readSystemDefaultSnapshot(this.getSystemDefaultSnapshotPath())?.authJson ?? null
    const preProvenanceRuntimeRefreshProven =
      provenanceStatus.kind === 'missing' &&
      snapshotAuth !== null &&
      this.runtimeAuthMatchesSystemDefaultIdentity(runtimeAuth, snapshotAuth) &&
      codexAuthIsMonotonicallyFresher(runtimeAuth, snapshotAuth)
    return {
      ownershipProven: provenance?.owner === 'system-default' || preProvenanceRuntimeRefreshProven,
      mirroredAuthJson:
        provenance?.owner === 'system-default'
          ? provenance.authJson
          : provenanceStatus.kind === 'missing'
            ? (this.lastWrittenAuthJson ?? snapshotAuth)
            : null
    }
  }

  private safeSyncForCurrentSelection(): void {
    try {
      this.syncForCurrentSelection()
    } catch (error) {
      console.warn('[codex-runtime-home] Failed to sync runtime auth state:', error)
    }
  }

  private safeRecoverInterruptedRuntimeAuthOperation(): void {
    try {
      recoverInterruptedGuardedFileOperation(this.getRuntimeAuthPath())
    } catch (error) {
      console.warn('[codex-runtime-home] Failed to recover interrupted auth update:', error)
    }
  }

  private getActiveAccount(
    accounts: CodexManagedAccount[],
    activeAccountId: string | null
  ): CodexManagedAccount | null {
    if (!activeAccountId) {
      return null
    }
    return accounts.find((account) => account.id === activeAccountId) ?? null
  }

  private getWslManagedHomePath(account: CodexManagedAccount | null): string | null {
    if (!account) {
      return null
    }
    if (account.managedHomeRuntime === 'wsl' && parseWslUncPath(account.managedHomePath)) {
      return account.managedHomePath
    }
    return parseWslUncPath(account.managedHomePath) ? account.managedHomePath : null
  }

  private getPreparedWslRateLimitHomePath(target: CodexAccountSelectionTarget): string | null {
    const distro = target.wslDistro?.trim()
    if (distro) {
      const settings = this.store.getSettings()
      const selectedAccountId = getSelectedCodexAccountIdForTarget(settings, target)
      if (selectedAccountId === null) {
        // Why: the system-default account changes outside Orca, so read its real home directly to avoid a stale cached runtime copy.
        return this.getWslSystemCodexHomePath(target)
      }
      const cachedRuntimeHomePath = this.wslRuntimeHomePathByDistro.get(distro)
      if (
        cachedRuntimeHomePath &&
        this.lastSyncedWslAccountIdByDistro.has(distro) &&
        this.lastSyncedWslAccountIdByDistro.get(distro) === selectedAccountId
      ) {
        // Why: RateLimitService resolves provenance twice per poll; stay path-only so it doesn't block main on UNC reads and a wsl.exe probe.
        return cachedRuntimeHomePath
      }
    }
    return this.syncWslRuntimeForCurrentSelection(target)
  }

  private syncWslRuntimeForCurrentSelection(target: CodexAccountSelectionTarget): string | null {
    if (process.platform !== 'win32') {
      return null
    }

    const wslTarget = this.resolveWslDefaultTarget(target)
    const settings = this.store.getSettings()
    const activeAccount = this.getActiveAccount(
      settings.codexManagedAccounts,
      getSelectedCodexAccountIdForTarget(settings, wslTarget)
    )
    const distro = wslTarget.wslDistro?.trim() || activeAccount?.wslDistro || getDefaultWslDistro()
    if (!distro) {
      return null
    }

    const runtimeHomePath = this.getWslRuntimeHomePath(distro)
    if (!runtimeHomePath) {
      return null
    }
    this.wslRuntimeHomePathByDistro.set(distro, runtimeHomePath)

    mkdirSync(runtimeHomePath, { recursive: true })
    this.safeMigrateLegacyWslActiveHomePointer(distro, runtimeHomePath)
    this.seedWslRuntimeHome(runtimeHomePath, activeAccount, distro)

    const runtimeAuthPath = join(runtimeHomePath, 'auth.json')
    const previousWslAccountId = this.lastSyncedWslAccountIdByDistro.get(distro) ?? null
    if (previousWslAccountId) {
      if (this.skipNextReadBackForAccountId === previousWslAccountId) {
        this.skipNextReadBackForAccountId = null
      } else {
        const previousWslAccount = this.getActiveAccount(
          settings.codexManagedAccounts,
          previousWslAccountId
        )
        if (previousWslAccount) {
          this.readBackRefreshedTokensFromPath(runtimeAuthPath, {
            updateLastWrittenAuthJson: true,
            lastWrittenAuthJson: this.lastWrittenWslAuthJsonByDistro.get(distro) ?? null,
            setLastWrittenAuthJson: (contents) => {
              this.lastWrittenWslAuthJsonByDistro.set(distro, contents)
            },
            expectedAccountId: previousWslAccount.id
          })
        }
      }
    }

    const activeAuthPath = activeAccount ? join(activeAccount.managedHomePath, 'auth.json') : null
    if (activeAccount && activeAuthPath && existsSync(activeAuthPath)) {
      const activeAuth = readFileSync(activeAuthPath, 'utf-8')
      this.writeRuntimeAuthAtPath(runtimeAuthPath, activeAuth)
      this.lastWrittenWslAuthJsonByDistro.set(distro, activeAuth)
      this.lastSyncedWslAccountIdByDistro.set(distro, activeAccount.id)
      return runtimeHomePath
    }
    if (activeAccount && activeAuthPath) {
      console.warn(
        '[codex-runtime-home] Active WSL managed account is missing auth.json, restoring system default'
      )
      this.store.updateSettings({
        activeCodexManagedAccountId: settings.activeCodexManagedAccountId,
        activeCodexManagedAccountIdsByRuntime: setSelectedCodexAccountIdForTarget(
          normalizeCodexRuntimeSelection(settings),
          null,
          wslTarget
        )
      })
    }

    const systemAuthPath = this.getWslSystemCodexAuthPath({ runtime: 'wsl', wslDistro: distro })
    if (systemAuthPath && existsSync(systemAuthPath)) {
      const systemAuth = readFileSync(systemAuthPath, 'utf-8')
      const mirroredSystemDefaultAuth = this.lastWrittenWslAuthJsonByDistro.get(distro) ?? null
      const runtimeAuth = existsSync(runtimeAuthPath)
        ? readFileSync(runtimeAuthPath, 'utf-8')
        : null
      if (
        runtimeAuth !== null &&
        runtimeAuth !== systemAuth &&
        this.runtimeAuthMatchesSystemDefaultIdentity(runtimeAuth, systemAuth) &&
        ((mirroredSystemDefaultAuth !== null && systemAuth === mirroredSystemDefaultAuth) ||
          (mirroredSystemDefaultAuth === null &&
            this.runtimeAuthIsFresher(runtimeAuth, systemAuth)))
      ) {
        // Why: WSL baselines are lost on restart, so a same-identity fresher runtime auth is a token refresh; copy it back before mirroring ~/.codex.
        this.writeRuntimeAuthAtPath(systemAuthPath, runtimeAuth)
        this.lastWrittenWslAuthJsonByDistro.set(distro, runtimeAuth)
        this.lastSyncedWslAccountIdByDistro.set(distro, null)
        return runtimeHomePath
      }
      this.writeRuntimeAuthAtPath(runtimeAuthPath, systemAuth)
      this.lastWrittenWslAuthJsonByDistro.set(distro, systemAuth)
      this.lastSyncedWslAccountIdByDistro.set(distro, null)
      return runtimeHomePath
    }

    rmSync(runtimeAuthPath, { force: true })
    this.lastWrittenWslAuthJsonByDistro.set(distro, null)
    this.lastSyncedWslAccountIdByDistro.set(distro, null)
    return runtimeHomePath
  }

  private getWslRuntimeHomePath(distro: string): string | null {
    const home = getWslHome(distro)
    return home ? this.joinWslPath(home, ...WSL_CODEX_RUNTIME_HOME_SEGMENTS) : null
  }

  private safeReadBackActiveWslAccountBeforeRestart(
    account: CodexManagedAccount,
    selectedDistroKey: string
  ): void {
    try {
      this.readBackActiveWslAccountBeforeRestart(account, selectedDistroKey)
    } catch (error) {
      console.warn('[codex-runtime-home] Failed to preserve WSL Codex auth before restart:', error)
    }
  }

  private readBackActiveWslAccountBeforeRestart(
    account: CodexManagedAccount,
    selectedDistroKey: string
  ): void {
    const distro =
      selectedDistroKey === getWslSelectionKey(null)
        ? account.wslDistro?.trim()
        : selectedDistroKey.trim() || account.wslDistro?.trim()
    if (!distro) {
      return
    }

    const runtimeHomePath = this.wslRuntimeHomePathByDistro.get(distro)
    if (!runtimeHomePath) {
      return
    }

    this.readBackRefreshedTokensFromPath(join(runtimeHomePath, 'auth.json'), {
      updateLastWrittenAuthJson: true,
      lastWrittenAuthJson: this.lastWrittenWslAuthJsonByDistro.get(distro) ?? null,
      setLastWrittenAuthJson: (contents) => {
        this.lastWrittenWslAuthJsonByDistro.set(distro, contents)
      },
      expectedAccountId: account.id
    })
  }

  private safeMigrateLegacyWslActiveHomePointer(distro: string, runtimeHomePath: string): void {
    try {
      this.migrateLegacyWslActiveHomePointer(distro, runtimeHomePath)
    } catch (error) {
      console.warn('[codex-runtime-home] Failed to migrate legacy WSL active Codex home:', error)
    }
  }

  private migrateLegacyWslActiveHomePointer(distro: string, runtimeHomePath: string): void {
    const runtimeWsl = parseWslUncPath(runtimeHomePath)
    if (!runtimeWsl?.linuxPath.endsWith('/codex-runtime-home/home')) {
      return
    }
    const activeLinuxPath = runtimeWsl.linuxPath.replace(
      /\/codex-runtime-home\/home$/,
      '/codex-runtime-home/active/wsl/home'
    )
    const nextLinuxPath = `${activeLinuxPath}.next-${process.pid}-${Date.now()}`
    const activeLinuxParentPath = this.dirnameLinuxPath(activeLinuxPath)
    // Why: WSL drops bash argv, so keep the script literal; login-shell cleanup turns `exit 0` into status 1, so fall through.
    execFileSync(
      'wsl.exe',
      [
        '-d',
        distro,
        '--',
        'bash',
        '-lc',
        [
          'set -e',
          `if [ ! -e ${this.quoteBashString(activeLinuxPath)} ] && [ ! -L ${this.quoteBashString(activeLinuxPath)} ]; then :`,
          `elif [ -e ${this.quoteBashString(activeLinuxPath)} ] && [ ! -L ${this.quoteBashString(activeLinuxPath)} ]; then :`,
          'else',
          `mkdir -p ${this.quoteBashString(activeLinuxParentPath)}`,
          `rm -rf -- ${this.quoteBashString(nextLinuxPath)}`,
          `ln -s -- ${this.quoteBashString(runtimeWsl.linuxPath)} ${this.quoteBashString(nextLinuxPath)}`,
          `mv -Tf -- ${this.quoteBashString(nextLinuxPath)} ${this.quoteBashString(activeLinuxPath)}`,
          'fi'
        ].join('\n')
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 }
    )
  }

  private dirnameLinuxPath(value: string): string {
    const index = value.lastIndexOf('/')
    return index > 0 ? value.slice(0, index) : '/'
  }

  private quoteBashString(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`
  }

  private joinWslPath(basePath: string, ...segments: string[]): string {
    return parseWslUncPath(basePath)
      ? pathWin32.join(basePath, ...segments)
      : join(basePath, ...segments)
  }

  private resolveWslDefaultTarget(
    target: CodexAccountSelectionTarget
  ): CodexAccountSelectionTarget {
    if (target.runtime !== 'wsl' || target.wslDistro?.trim()) {
      return target
    }
    const defaultDistro = getDefaultWslDistro()
    return defaultDistro ? { runtime: 'wsl', wslDistro: defaultDistro } : target
  }

  private getWslSystemCodexAuthPath(target: CodexAccountSelectionTarget): string | null {
    const home = this.getWslSystemCodexHomePath(target)
    return home ? this.joinWslPath(home, 'auth.json') : null
  }

  private seedWslRuntimeHome(
    runtimeHomePath: string,
    activeAccount: CodexManagedAccount | null,
    distro: string
  ): void {
    const runtimeConfigPath = join(runtimeHomePath, 'config.toml')
    if (existsSync(runtimeConfigPath)) {
      return
    }

    const candidateHomes = [
      activeAccount?.managedHomePath,
      this.getWslSystemCodexHomePath({ runtime: 'wsl', wslDistro: distro })
    ].filter((value): value is string => Boolean(value))
    for (const homePath of candidateHomes) {
      const configPath = join(homePath, 'config.toml')
      if (existsSync(configPath)) {
        writeFileAtomically(
          runtimeConfigPath,
          prepareWslRuntimeSeedConfig(readFileSync(configPath, 'utf-8'), homePath)
        )
        return
      }
    }
  }

  private findManagedAccountForRuntimeAuth(
    runtimeAuthContents: string,
    expectedAccountId?: string
  ): CodexReadBackMatch {
    const matches: {
      account: CodexManagedAccount
      managedAuthPath: string
      managedAuthContents: string
    }[] = []
    let unreadableHomeCouldOwnRuntimeAuth = false
    for (const account of this.store.getSettings().codexManagedAccounts) {
      if (expectedAccountId && account.id !== expectedAccountId) {
        continue
      }
      const managedAuthPath = join(account.managedHomePath, 'auth.json')
      if (!existsSync(managedAuthPath)) {
        continue
      }
      let managedAuthContents: string
      try {
        managedAuthContents = readFileSync(managedAuthPath, 'utf-8')
      } catch {
        // Why: an unreadable home can never be compared, but letting the read
        // throw abandons the scan for every other account — dropping a refresh
        // the runtime home holds for one of them. Only its record can rule it
        // out as the owner; when it cannot, the scan is no longer unambiguous.
        if (
          !expectedAccountId &&
          codexAuthCouldBelongToManagedAccount(runtimeAuthContents, account)
        ) {
          unreadableHomeCouldOwnRuntimeAuth = true
        }
        continue
      }
      if (codexAuthMatchesManagedAccount(runtimeAuthContents, account, managedAuthContents)) {
        matches.push({ account, managedAuthPath, managedAuthContents })
      }
    }

    if (unreadableHomeCouldOwnRuntimeAuth) {
      return { kind: 'ambiguous' }
    }
    if (matches.length === 1) {
      return { kind: 'matched', ...matches[0] }
    }
    return { kind: matches.length === 0 ? 'none' : 'ambiguous' }
  }

  private runtimeAuthMatchesSystemDefaultIdentity(
    runtimeAuthContents: string,
    systemDefaultAuthContents: string
  ): boolean {
    return codexAuthMatchesSystemDefaultIdentity(runtimeAuthContents, systemDefaultAuthContents)
  }

  private runtimeAuthIsFresher(runtimeAuthContents: string, managedAuthContents: string): boolean {
    return codexAuthIsFresher(runtimeAuthContents, managedAuthContents)
  }

  private safeMigrateLegacySharedAuth(): void {
    const settings = this.store.getSettings()
    try {
      migrateLegacySharedAuthToPerAccountHome({
        activeHostAccountId: normalizeCodexRuntimeSelection(settings).host,
        hostAccounts: settings.codexManagedAccounts.filter(
          (account) => !this.getWslManagedHomePath(account)
        ),
        managedAccountsRoot: this.getManagedAccountsRoot(),
        metadataDir: this.getRuntimeMetadataDir(),
        sharedRuntimeHome: this.getRuntimeHomePath(),
        systemCodexHome: getSystemCodexHomePath()
      })
    } catch (error) {
      // Why: an inconclusive identity, ownership, or filesystem result must
      // leave the marker absent so the next startup can retry safely.
      console.warn('[codex-runtime-home] Failed to migrate legacy shared Codex auth:', error)
    }
  }

  private safeMigrateLegacyManagedState(): void {
    try {
      this.migrateLegacyManagedStateIfNeeded()
    } catch (error) {
      console.warn('[codex-runtime-home] Failed to migrate legacy managed Codex state:', error)
    }
  }

  private safeMigrateLegacyActiveHomePointer(): void {
    try {
      const activeHomePath = this.getLegacyHostActiveHomePath()
      if (!this.legacyActiveHomePathExists(activeHomePath)) {
        return
      }
      this.repointLegacyActiveHomePointer(activeHomePath, this.getRuntimeHomePath())
    } catch (error) {
      console.warn('[codex-runtime-home] Failed to migrate legacy active Codex home:', error)
    }
  }

  private getRuntimeHomePath(): string {
    return getOrcaManagedCodexHomePath()
  }

  /**
   * Resolves the managed home the config mirror actually targets for the
   * current HOST selection, or null when no mirror runs for it.
   *
   * Read-only on purpose: unlike the launch and quota-fetch paths this prepares
   * nothing and creates no directories, so surfacing sync health cannot alter
   * the state it is reporting on. Returns null for the system default on the
   * real-home lane, which runs Codex directly against ~/.codex — there is no
   * mirror there, so there is nothing that can fall behind.
   */
  getMirroredHostHomePathForStatus(): string | null {
    const selfContainedAccount = this.getSelfContainedManagedHostAccount()
    if (selfContainedAccount) {
      return this.getTrustedSelfContainedManagedHomePath(selfContainedAccount)
    }
    if (this.isHostSystemDefaultRealHome()) {
      return null
    }
    return join(getOrcaUserDataPath(), 'codex-runtime-home', 'home')
  }

  private getRuntimeAuthPath(): string {
    return join(this.getRuntimeHomePath(), 'auth.json')
  }

  private getSystemDefaultSnapshotPath(): string {
    return join(this.getRuntimeMetadataDir(), 'system-default-auth.json')
  }

  private getRuntimeLogoutMarkerPath(): string {
    return join(this.getRuntimeMetadataDir(), 'system-default-runtime-logout.json')
  }

  private getSharedRuntimeAuthProvenancePath(): string {
    return join(this.getRuntimeMetadataDir(), 'shared-runtime-auth-provenance.json')
  }

  private getRuntimeMetadataDir(): string {
    const metadataDir = join(app.getPath('userData'), 'codex-runtime-home')
    mkdirSync(metadataDir, { recursive: true })
    return metadataDir
  }

  private getLegacyHostActiveHomePath(): string {
    return join(this.getRuntimeMetadataDir(), 'active', 'host', 'home')
  }

  private getMigrationMarkerPath(): string {
    return join(this.getRuntimeMetadataDir(), 'migration-v1.json')
  }

  private getMigrationDiagnosticsPath(): string {
    return join(this.getRuntimeMetadataDir(), 'migration-diagnostics.jsonl')
  }

  private getManagedAccountsRoot(): string {
    return join(app.getPath('userData'), 'codex-accounts')
  }

  private repointLegacyActiveHomePointer(activeHomePath: string, runtimeHomePath: string): void {
    if (this.activeHomeAlreadyPointsToRuntimeHome(activeHomePath, runtimeHomePath)) {
      return
    }
    if (!this.legacyActiveHomeLinkIsReplaceable(activeHomePath)) {
      return
    }

    mkdirSync(runtimeHomePath, { recursive: true })
    mkdirSync(dirname(activeHomePath), { recursive: true })
    const nextLinkPath = `${activeHomePath}.next-${process.pid}-${Date.now()}`
    this.removeLegacyActiveHomeLinkIfOwned(nextLinkPath)
    try {
      symlinkSync(
        runtimeHomePath,
        nextLinkPath,
        process.platform === 'win32' && lstatSync(runtimeHomePath).isDirectory()
          ? 'junction'
          : undefined
      )
      try {
        renameSync(nextLinkPath, activeHomePath)
      } catch (error) {
        if (!this.legacyActiveHomeLinkIsReplaceable(activeHomePath)) {
          throw error
        }
        this.removeLegacyActiveHomeLinkIfOwned(activeHomePath)
        renameSync(nextLinkPath, activeHomePath)
      }
    } finally {
      this.removeLegacyActiveHomeLinkIfOwned(nextLinkPath)
    }
  }

  private activeHomeAlreadyPointsToRuntimeHome(
    activeHomePath: string,
    runtimeHomePath: string
  ): boolean {
    try {
      return this.linkTargetsMatch(readlinkSync(activeHomePath), activeHomePath, runtimeHomePath)
    } catch {
      return false
    }
  }

  private linkTargetsMatch(
    linkTarget: string,
    linkPath: string,
    expectedTargetPath: string
  ): boolean {
    const resolvedLinkTarget = isAbsolute(linkTarget)
      ? resolve(linkTarget)
      : resolve(dirname(linkPath), linkTarget)
    return resolvedLinkTarget === resolve(expectedTargetPath)
  }

  private legacyActiveHomeLinkIsReplaceable(activeHomePath: string): boolean {
    try {
      const stat = lstatSync(activeHomePath)
      return stat.isSymbolicLink() || this.isWindowsReadableLink(activeHomePath)
    } catch {
      return true
    }
  }

  private legacyActiveHomePathExists(activeHomePath: string): boolean {
    try {
      lstatSync(activeHomePath)
      return true
    } catch {
      return false
    }
  }

  private removeLegacyActiveHomeLinkIfOwned(activeHomePath: string): void {
    try {
      const stat = lstatSync(activeHomePath)
      if (stat.isSymbolicLink()) {
        unlinkSync(activeHomePath)
      } else if (this.isWindowsReadableLink(activeHomePath)) {
        rmdirSync(activeHomePath)
      }
    } catch {
      // Missing or inaccessible temporary links are handled by the caller.
    }
  }

  private isWindowsReadableLink(targetPath: string): boolean {
    if (process.platform !== 'win32') {
      return false
    }
    try {
      readlinkSync(targetPath)
      return true
    } catch {
      return false
    }
  }

  private migrateLegacyManagedStateIfNeeded(): void {
    if (existsSync(this.getMigrationMarkerPath())) {
      return
    }

    const managedHomes = this.getLegacyManagedHomes()
    for (const managedHomePath of managedHomes) {
      const accountId = parse(relative(this.getManagedAccountsRoot(), managedHomePath)).dir.split(
        /[\\/]/
      )[0]
      if (!accountId) {
        continue
      }
      this.migrateLegacyHistory(managedHomePath)
      this.migrateLegacySessions(managedHomePath, accountId)
    }

    // Why: migration is one-shot; re-importing every startup would replay stale managed-home state into the shared runtime.
    writeFileAtomically(
      this.getMigrationMarkerPath(),
      `${JSON.stringify({ completedAt: Date.now(), migratedHomeCount: managedHomes.length })}\n`
    )
  }

  private getLegacyManagedHomes(): string[] {
    const managedAccountsRoot = this.getManagedAccountsRoot()
    if (!existsSync(managedAccountsRoot)) {
      return []
    }

    const accountEntries = readdirSync(managedAccountsRoot, { withFileTypes: true })
    const managedHomes: string[] = []
    for (const entry of accountEntries) {
      if (!entry.isDirectory()) {
        continue
      }
      const managedHomePath = join(managedAccountsRoot, entry.name, 'home')
      if (existsSync(join(managedHomePath, '.orca-managed-home'))) {
        managedHomes.push(managedHomePath)
      }
    }
    return managedHomes.sort()
  }

  private migrateLegacyHistory(managedHomePath: string): void {
    const legacyHistoryPath = join(managedHomePath, 'history.jsonl')
    if (!existsSync(legacyHistoryPath)) {
      return
    }

    const runtimeHistoryPath = join(this.getRuntimeHomePath(), 'history.jsonl')
    const existingLines = existsSync(runtimeHistoryPath)
      ? readFileSync(runtimeHistoryPath, 'utf-8').split('\n').filter(Boolean)
      : []
    const mergedLines = [...existingLines]
    const seenLines = new Set(existingLines)
    for (const line of readFileSync(legacyHistoryPath, 'utf-8').split('\n')) {
      if (!line || seenLines.has(line)) {
        continue
      }
      seenLines.add(line)
      mergedLines.push(line)
    }

    if (mergedLines.length === 0) {
      return
    }
    writeFileAtomically(runtimeHistoryPath, `${mergedLines.join('\n')}\n`)
  }

  private migrateLegacySessions(managedHomePath: string, accountId: string): void {
    const legacySessionsRoot = join(managedHomePath, 'sessions')
    if (!existsSync(legacySessionsRoot)) {
      return
    }

    const runtimeSessionsRoot = join(this.getRuntimeHomePath(), 'sessions')
    mkdirSync(runtimeSessionsRoot, { recursive: true })
    for (const legacyFilePath of this.listFilesRecursively(legacySessionsRoot)) {
      const relativePath = relative(legacySessionsRoot, legacyFilePath)
      const runtimeFilePath = join(runtimeSessionsRoot, relativePath)
      mkdirSync(dirname(runtimeFilePath), { recursive: true })
      if (!existsSync(runtimeFilePath)) {
        copyFileSync(legacyFilePath, runtimeFilePath)
        continue
      }

      const legacyContents = readFileSync(legacyFilePath)
      const runtimeContents = readFileSync(runtimeFilePath)
      if (runtimeContents.equals(legacyContents)) {
        continue
      }

      const preservedPath = this.getPreservedLegacySessionPath(runtimeFilePath, accountId)
      copyFileSync(legacyFilePath, preservedPath)
      this.appendMigrationDiagnostic({
        type: 'session-conflict',
        accountId,
        runtimeFilePath,
        preservedPath
      })
    }
  }

  private listFilesRecursively(rootPath: string): string[] {
    const stat = statSync(rootPath)
    if (!stat.isDirectory()) {
      return [rootPath]
    }

    const files: string[] = []
    for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
      const childPath = join(rootPath, entry.name)
      if (entry.isDirectory()) {
        this.appendListedFiles(files, this.listFilesRecursively(childPath))
        continue
      }
      if (entry.isFile()) {
        files.push(childPath)
      }
    }
    return files.sort()
  }

  private appendListedFiles(target: string[], source: readonly string[]): void {
    // Why: tolerate directories larger than V8's argument limit for spread calls.
    for (const filePath of source) {
      target.push(filePath)
    }
  }

  private getPreservedLegacySessionPath(runtimeFilePath: string, accountId: string): string {
    const extension = extname(runtimeFilePath)
    const basename = runtimeFilePath.slice(0, runtimeFilePath.length - extension.length)
    return `${basename}.orca-legacy-${accountId}${extension}`
  }

  private appendMigrationDiagnostic(record: Record<string, string>): void {
    const diagnosticsPath = this.getMigrationDiagnosticsPath()
    try {
      appendFileSync(diagnosticsPath, `${JSON.stringify(record)}\n`, { encoding: 'utf-8' })
    } catch (error) {
      // Why: diagnostics must not fail the one-shot migration after the session file is already preserved.
      console.warn('[codex-runtime-home] Failed to append migration diagnostic:', error)
    }
  }

  private captureSystemDefaultSnapshot(options: { force: boolean }): void {
    const snapshotPath = this.getSystemDefaultSnapshotPath()
    if (!options.force && existsSync(snapshotPath)) {
      return
    }

    const runtimeAuthPath = join(getSystemCodexHomePath(), 'auth.json')
    const snapshot: CodexSystemDefaultSnapshot = {
      authJson: existsSync(runtimeAuthPath) ? readFileSync(runtimeAuthPath, 'utf-8') : null
    }
    writeFileAtomically(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 })
  }

  private syncRuntimeAuthWithSystemDefault(): void {
    const runtimeAuthPath = this.getRuntimeAuthPath()
    const systemDefaultAuthPath = join(getSystemCodexHomePath(), 'auth.json')
    if (!existsSync(runtimeAuthPath)) {
      return
    }

    try {
      const runtimeAuth = readFileSync(runtimeAuthPath, 'utf-8')
      const provenanceStatus = this.resolveSharedRuntimeAuthProvenanceStatus()
      const provenance = provenanceStatus.kind === 'committed' ? provenanceStatus.provenance : null
      if (provenance?.owner === 'managed') {
        this.captureSystemDefaultSnapshot({ force: true })
        if (!existsSync(systemDefaultAuthPath)) {
          this.clearRuntimeAuthAfterSystemDefaultLogout(runtimeAuthPath)
          return
        }
        this.writeRuntimeAuth(readFileSync(systemDefaultAuthPath, 'utf-8'), {
          owner: 'system-default'
        })
        return
      }
      const {
        ownershipProven: systemDefaultOwnershipProven,
        mirroredAuthJson: mirroredSystemDefaultAuth
      } = this.resolveSystemDefaultMirrorClaim(runtimeAuth, provenanceStatus)
      if (!existsSync(systemDefaultAuthPath)) {
        if (mirroredSystemDefaultAuth !== null && runtimeAuth === mirroredSystemDefaultAuth) {
          this.clearRuntimeAuthAfterSystemDefaultLogout(runtimeAuthPath)
          return
        }
        if (
          systemDefaultOwnershipProven &&
          mirroredSystemDefaultAuth !== null &&
          this.runtimeAuthMatchesSystemDefaultIdentity(runtimeAuth, mirroredSystemDefaultAuth)
        ) {
          this.clearRuntimeAuthAfterSystemDefaultLogout(runtimeAuthPath)
        }
        return
      }
      const systemDefaultAuth = readFileSync(systemDefaultAuthPath, 'utf-8')
      if (runtimeAuth === systemDefaultAuth) {
        this.writeRuntimeAuth(systemDefaultAuth, { owner: 'system-default' })
        return
      }
      if (
        systemDefaultOwnershipProven &&
        mirroredSystemDefaultAuth !== null &&
        systemDefaultAuth === mirroredSystemDefaultAuth &&
        this.runtimeAuthMatchesSystemDefaultIdentity(runtimeAuth, mirroredSystemDefaultAuth)
      ) {
        // Why: Codex refreshes tokens in the runtime CODEX_HOME; read that back to ~/.codex so the next sync won't clobber fresh creds with stale ones.
        this.writeSystemDefaultAuth(runtimeAuth)
        this.captureSystemDefaultSnapshot({ force: true })
        this.writeRuntimeAuth(runtimeAuth, { owner: 'system-default' })
        return
      }
      // Why: mirror external logins/logouts into Orca's runtime home so unmanaged Codex sessions keep matching the current system-default state.
      this.captureSystemDefaultSnapshot({ force: true })
      this.writeRuntimeAuth(systemDefaultAuth, { owner: 'system-default' })
    } catch (error) {
      console.warn('[codex-runtime-home] Failed to sync system-default auth:', error)
    }
  }

  private syncLegacySharedSystemDefaultAuthForRetainedPanes(): void {
    if (this.sharedAuthRefreshBlockedByManagedTransition || this.lastSyncedAccountId !== null) {
      this.sharedAuthRefreshBlockedByManagedTransition = false
      return
    }
    const runtimeAuthPath = this.getRuntimeAuthPath()
    try {
      let provenanceStatus = this.resolveSharedRuntimeAuthProvenanceStatus()
      if (
        provenanceStatus.kind === 'committed' &&
        provenanceStatus.provenance.owner === 'managed'
      ) {
        const restoredProvenance = this.restoreUntouchedSystemDefaultProvenance(
          provenanceStatus.provenance
        )
        if (restoredProvenance) {
          provenanceStatus = { kind: 'committed', provenance: restoredProvenance }
        }
      }
      if (
        provenanceStatus.kind === 'fenced' ||
        (provenanceStatus.kind === 'committed' && provenanceStatus.provenance.owner === 'managed')
      ) {
        return
      }
      const systemAuth = this.readSystemDefaultAuth()
      if (!existsSync(runtimeAuthPath)) {
        const logoutMarkerStatus = this.getRuntimeLogoutMarkerStatus()
        const snapshot = this.readSystemDefaultSnapshot(this.getSystemDefaultSnapshotPath())
        const knownSystemAuthBaseline =
          provenanceStatus.kind === 'committed' &&
          provenanceStatus.provenance.owner === 'system-default'
            ? provenanceStatus.provenance.authJson
            : provenanceStatus.kind === 'missing'
              ? (this.lastWrittenAuthJson ?? snapshot?.authJson)
              : undefined
        if (systemAuth === null) {
          if (
            provenanceStatus.kind === 'committed' &&
            provenanceStatus.provenance.owner === 'system-default' &&
            provenanceStatus.provenance.authJson === null &&
            logoutMarkerStatus.kind === 'applies' &&
            snapshot?.authJson === null
          ) {
            this.lastWrittenAuthJson = null
            return
          }
          // Why: commit a crashed logout before a managed transition can discard its recovery baseline.
          this.captureSystemDefaultSnapshot({ force: true })
          this.persistRuntimeLogoutMarker(null)
          this.lastWrittenAuthJson = null
          this.persistSharedRuntimeAuthProvenance({ owner: 'system-default', authJson: null })
          return
        }
        if (
          logoutMarkerStatus.kind === 'system-default-changed' ||
          (knownSystemAuthBaseline !== undefined && knownSystemAuthBaseline !== systemAuth)
        ) {
          const replaced = this.writeRuntimeAuth(
            systemAuth,
            {
              owner: 'system-default'
            },
            { expectedContents: null }
          )
          if (replaced) {
            this.captureSystemDefaultSnapshot({ force: true })
          }
        }
        return
      }
      const runtimeAuthBeforeSync = readFileSync(runtimeAuthPath, 'utf-8')
      const snapshot = this.readSystemDefaultSnapshot(this.getSystemDefaultSnapshotPath())
      const provenance = provenanceStatus.kind === 'committed' ? provenanceStatus.provenance : null
      const knownSharedAuth =
        provenance?.owner === 'system-default'
          ? provenance.authJson
          : provenanceStatus.kind === 'missing'
            ? (this.lastWrittenAuthJson ?? snapshot?.authJson ?? null)
            : null
      // Why: only bytes Orca can prove it wrote belong to the compatibility
      // mirror; retained Codex or a managed transition owns every other value.
      if (knownSharedAuth === null) {
        return
      }
      const sharedAuthOwnedBySystemDefault =
        runtimeAuthBeforeSync === knownSharedAuth ||
        (provenance?.owner === 'system-default' &&
          systemAuth === null &&
          this.runtimeAuthMatchesSystemDefaultIdentity(runtimeAuthBeforeSync, knownSharedAuth))
      if (!sharedAuthOwnedBySystemDefault) {
        return
      }
      if (systemAuth === null) {
        removeFileAtomicallyIfUnchanged(runtimeAuthPath, runtimeAuthBeforeSync)
        if (existsSync(runtimeAuthPath)) {
          this.persistSharedRuntimeAuthProvenance({ owner: 'fenced' })
          return
        }
        this.captureSystemDefaultSnapshot({ force: true })
        this.persistRuntimeLogoutMarker(null)
        this.lastWrittenAuthJson = null
        this.persistSharedRuntimeAuthProvenance({
          owner: 'system-default',
          authJson: null
        })
        return
      }
      if (runtimeAuthBeforeSync !== knownSharedAuth) {
        return
      }
      const replaced = this.writeRuntimeAuth(
        systemAuth,
        { owner: 'system-default' },
        { expectedContents: runtimeAuthBeforeSync }
      )
      if (replaced) {
        this.captureSystemDefaultSnapshot({ force: true })
      }
    } catch (error) {
      console.warn('[codex-runtime-home] Failed to refresh retained-pane auth:', error)
    }
  }

  private restoreSystemDefaultSnapshot(options: { detectExternalLogin: boolean }): void {
    const snapshotPath = this.getSystemDefaultSnapshotPath()
    const runtimeAuthPath = this.getRuntimeAuthPath()
    const systemDefaultAuthPath = join(getSystemCodexHomePath(), 'auth.json')
    if (existsSync(systemDefaultAuthPath)) {
      const systemDefaultAuth = readFileSync(systemDefaultAuthPath, 'utf-8')
      this.captureSystemDefaultSnapshot({ force: true })
      this.writeRuntimeAuth(systemDefaultAuth, { owner: 'system-default' })
      return
    }

    if (options.detectExternalLogin && !existsSync(runtimeAuthPath)) {
      // Why: with Orca owning CODEX_HOME, a deleted runtime auth.json is a local logout, not a cue to restore the user's real ~/.codex snapshot.
      this.persistRuntimeLogoutMarker()
      this.lastWrittenAuthJson = null
      this.persistSharedRuntimeAuthProvenance({ owner: 'system-default', authJson: null })
      return
    }

    if (options.detectExternalLogin) {
      // Why: if ~/.codex/auth.json vanished while a managed account was selected, switching back must preserve that external system-default logout.
      rmSync(runtimeAuthPath, { force: true })
      this.captureSystemDefaultSnapshot({ force: true })
      this.persistRuntimeLogoutMarker()
      this.lastWrittenAuthJson = null
      this.persistSharedRuntimeAuthProvenance({ owner: 'system-default', authJson: null })
      return
    }

    if (!existsSync(snapshotPath)) {
      this.captureSystemDefaultSnapshot({ force: true })
    }

    const snapshot = this.readSystemDefaultSnapshot(snapshotPath)
    if (!snapshot) {
      console.warn('[codex-runtime-home] Ignoring invalid system-default auth snapshot')
      rmSync(snapshotPath, { force: true })
      this.captureSystemDefaultSnapshot({ force: true })
      const refreshedSnapshot = this.readSystemDefaultSnapshot(snapshotPath)
      if (!refreshedSnapshot) {
        rmSync(runtimeAuthPath, { force: true })
        this.lastWrittenAuthJson = null
        this.persistSharedRuntimeAuthProvenance({ owner: 'system-default', authJson: null })
        return
      }
      if (refreshedSnapshot.authJson === null) {
        rmSync(runtimeAuthPath, { force: true })
        this.lastWrittenAuthJson = null
        this.persistSharedRuntimeAuthProvenance({ owner: 'system-default', authJson: null })
        return
      }
      this.writeRuntimeAuth(refreshedSnapshot.authJson, { owner: 'system-default' })
      return
    }
    if (snapshot.authJson === null) {
      rmSync(runtimeAuthPath, { force: true })
      this.lastWrittenAuthJson = null
      this.persistSharedRuntimeAuthProvenance({ owner: 'system-default', authJson: null })
      return
    }
    this.writeRuntimeAuth(snapshot.authJson, { owner: 'system-default' })
  }

  private writeSystemDefaultAuth(contents: string): void {
    const systemDefaultAuthPath = join(getSystemCodexHomePath(), 'auth.json')
    mkdirSync(dirname(systemDefaultAuthPath), { recursive: true })
    writeFileAtomically(systemDefaultAuthPath, contents, { mode: 0o600 })
    this.ensureOwnerOnlyMode(systemDefaultAuthPath)
  }

  private clearRuntimeAuthAfterSystemDefaultLogout(runtimeAuthPath: string): void {
    // Why: a vanished ~/.codex auth means external logout for unmanaged sessions, even if runtime auth already refreshed in Orca's CODEX_HOME.
    rmSync(runtimeAuthPath, { force: true })
    this.captureSystemDefaultSnapshot({ force: true })
    this.persistRuntimeLogoutMarker()
    this.lastWrittenAuthJson = null
    this.persistSharedRuntimeAuthProvenance({
      owner: 'system-default',
      authJson: null
    })
  }

  private readSystemDefaultAuth(): string | null {
    const systemDefaultAuthPath = join(getSystemCodexHomePath(), 'auth.json')
    return existsSync(systemDefaultAuthPath) ? readFileSync(systemDefaultAuthPath, 'utf-8') : null
  }

  private writeRuntimeAuth(
    contents: string,
    owner: { owner: 'system-default' } | { owner: 'managed'; accountId: string },
    options?: { expectedContents: string | null }
  ): boolean {
    // Why: auth.json holds credentials; restrict to owner-only so other users on a shared machine cannot read it.
    const runtimeAuthPath = this.getRuntimeAuthPath()
    if (options && !this.fileContentsMatchExpected(runtimeAuthPath, options.expectedContents)) {
      return false
    }
    const provenance: CodexSharedRuntimeAuthProvenance =
      owner.owner === 'system-default' ? { owner: 'system-default', authJson: contents } : owner
    const runtimeAuthAlreadyMatches = this.fileContentsEqual(runtimeAuthPath, contents)
    if (
      runtimeAuthAlreadyMatches &&
      this.sharedRuntimeAuthProvenanceMatches(
        this.resolveSharedRuntimeAuthProvenanceStatus(),
        provenance
      )
    ) {
      this.ensureOwnerOnlyMode(runtimeAuthPath)
      this.lastWrittenAuthJson = contents
      this.clearRuntimeLogoutMarker()
      return true
    }
    this.persistSharedRuntimeAuthProvenance({
      owner: 'pending',
      next: provenance,
      runtimeAuthJson: contents
    })
    if (runtimeAuthAlreadyMatches) {
      this.ensureOwnerOnlyMode(runtimeAuthPath)
      this.lastWrittenAuthJson = contents
      this.persistSharedRuntimeAuthProvenance(provenance)
      this.clearRuntimeLogoutMarker()
      return true
    }
    const replaced = options
      ? writeFileAtomicallyIfUnchanged(runtimeAuthPath, options.expectedContents, contents, {
          mode: 0o600
        })
      : (writeFileAtomically(runtimeAuthPath, contents, { mode: 0o600 }), true)
    if (!replaced) {
      return false
    }
    this.lastWrittenAuthJson = contents
    this.persistSharedRuntimeAuthProvenance(provenance)
    this.clearRuntimeLogoutMarker()
    return true
  }

  private writeRuntimeAuthAtPath(authPath: string, contents: string): void {
    if (this.fileContentsEqual(authPath, contents)) {
      this.ensureOwnerOnlyMode(authPath)
      return
    }
    mkdirSync(dirname(authPath), { recursive: true })
    writeFileAtomically(authPath, contents, { mode: 0o600 })
  }

  private fileContentsEqual(targetPath: string, contents: string): boolean {
    try {
      return existsSync(targetPath) && readFileSync(targetPath, 'utf-8') === contents
    } catch {
      return false
    }
  }

  private fileContentsMatchExpected(targetPath: string, expectedContents: string | null): boolean {
    if (expectedContents === null) {
      return !existsSync(targetPath)
    }
    return this.fileContentsEqual(targetPath, expectedContents)
  }

  private ensureOwnerOnlyMode(targetPath: string): void {
    if (process.platform === 'win32') {
      return
    }
    try {
      chmodSync(targetPath, 0o600)
    } catch {
      /* Best effort: the next atomic write will set the restrictive mode. */
    }
  }

  private getRuntimeLogoutMarkerStatus(): CodexRuntimeLogoutMarkerStatus {
    const marker = this.readRuntimeLogoutMarker()
    if (!marker) {
      return { kind: 'missing' }
    }
    const systemDefaultAuthJson = this.readSystemDefaultAuth()
    if (systemDefaultAuthJson === marker.systemDefaultAuthJson) {
      return { kind: 'applies' }
    }
    this.clearRuntimeLogoutMarker()
    return { kind: 'system-default-changed', systemDefaultAuthJson }
  }

  private persistRuntimeLogoutMarker(systemDefaultAuthJson = this.readSystemDefaultAuth()): void {
    const marker: CodexRuntimeLogoutMarker = {
      systemDefaultAuthJson,
      loggedOutAt: Date.now()
    }
    writeFileAtomically(this.getRuntimeLogoutMarkerPath(), `${JSON.stringify(marker, null, 2)}\n`, {
      mode: 0o600
    })
  }

  private readRuntimeLogoutMarker(): CodexRuntimeLogoutMarker | null {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.getRuntimeLogoutMarkerPath(), 'utf-8')) as unknown
    } catch {
      return null
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      !('systemDefaultAuthJson' in parsed) ||
      !('loggedOutAt' in parsed)
    ) {
      return null
    }
    const marker = parsed as { systemDefaultAuthJson: unknown; loggedOutAt: unknown }
    if (
      (marker.systemDefaultAuthJson !== null && typeof marker.systemDefaultAuthJson !== 'string') ||
      typeof marker.loggedOutAt !== 'number'
    ) {
      return null
    }
    return marker as CodexRuntimeLogoutMarker
  }

  private clearRuntimeLogoutMarker(): void {
    rmSync(this.getRuntimeLogoutMarkerPath(), { force: true })
  }

  private persistSharedRuntimeAuthProvenance(
    provenance: CodexSharedRuntimeAuthProvenanceFile
  ): void {
    writeFileAtomically(
      this.getSharedRuntimeAuthProvenancePath(),
      `${JSON.stringify(provenance, null, 2)}\n`,
      { mode: 0o600 }
    )
  }

  private markSharedRuntimeAuthManaged(accountId: string): void {
    const status = this.resolveSharedRuntimeAuthProvenanceStatus()
    if (
      status.kind === 'committed' &&
      status.provenance.owner === 'managed' &&
      status.provenance.accountId === accountId
    ) {
      return
    }
    const runtimeAuthJson = this.readRuntimeAuthForProvenance()
    const systemDefaultBaseline = this.getUntouchedSystemDefaultBaseline(status, runtimeAuthJson)
    const provenance: CodexSharedRuntimeAuthProvenance = {
      owner: 'managed',
      accountId,
      ...(systemDefaultBaseline ? { systemDefaultBaseline } : {})
    }
    this.persistSharedRuntimeAuthProvenance({
      owner: 'pending',
      next: provenance,
      runtimeAuthJson
    })
    if (this.readRuntimeAuthForProvenance() === runtimeAuthJson) {
      this.persistSharedRuntimeAuthProvenance(provenance)
    }
  }

  private getUntouchedSystemDefaultBaseline(
    status: CodexSharedRuntimeAuthProvenanceStatus,
    runtimeAuthJson: string | null
  ): { authJson: string | null } | null {
    if (status.kind !== 'committed') {
      return null
    }
    const baseline =
      status.provenance.owner === 'system-default'
        ? { authJson: status.provenance.authJson }
        : status.provenance.systemDefaultBaseline
    return baseline && runtimeAuthJson === baseline.authJson ? baseline : null
  }

  private restoreUntouchedSystemDefaultProvenance(
    provenance: Extract<CodexSharedRuntimeAuthProvenance, { owner: 'managed' }>
  ): Extract<CodexSharedRuntimeAuthProvenance, { owner: 'system-default' }> | null {
    const baseline = provenance.systemDefaultBaseline
    if (!baseline || this.readRuntimeAuthForProvenance() !== baseline.authJson) {
      return null
    }
    const restored = { owner: 'system-default' as const, authJson: baseline.authJson }
    this.persistSharedRuntimeAuthProvenance({
      owner: 'pending',
      next: restored,
      runtimeAuthJson: baseline.authJson
    })
    if (this.readRuntimeAuthForProvenance() !== baseline.authJson) {
      return null
    }
    this.persistSharedRuntimeAuthProvenance(restored)
    return restored
  }

  private sharedRuntimeAuthProvenanceMatches(
    status: CodexSharedRuntimeAuthProvenanceStatus,
    expected: CodexSharedRuntimeAuthProvenance
  ): boolean {
    if (status.kind !== 'committed' || status.provenance.owner !== expected.owner) {
      return false
    }
    return expected.owner === 'system-default'
      ? status.provenance.owner === 'system-default' &&
          status.provenance.authJson === expected.authJson
      : status.provenance.owner === 'managed' && status.provenance.accountId === expected.accountId
  }

  private resolveSharedRuntimeAuthProvenanceStatus(): CodexSharedRuntimeAuthProvenanceStatus {
    const provenancePath = this.getSharedRuntimeAuthProvenancePath()
    if (!existsSync(provenancePath)) {
      return { kind: 'missing' }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(provenancePath, 'utf-8')) as unknown
    } catch {
      return { kind: 'fenced' }
    }
    const committed = this.parseSharedRuntimeAuthProvenance(parsed)
    if (committed) {
      return { kind: 'committed', provenance: committed }
    }
    const pending = this.parsePendingSharedRuntimeAuthProvenance(parsed)
    if (!pending || this.readRuntimeAuthForProvenance() !== pending.runtimeAuthJson) {
      return { kind: 'fenced' }
    }
    try {
      this.persistSharedRuntimeAuthProvenance(pending.next)
      return { kind: 'committed', provenance: pending.next }
    } catch {
      return { kind: 'fenced' }
    }
  }

  private parseSharedRuntimeAuthProvenance(
    value: unknown
  ): CodexSharedRuntimeAuthProvenance | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null
    }
    const provenance = value as Record<string, unknown>
    if (
      provenance.owner === 'system-default' &&
      (typeof provenance.authJson === 'string' || provenance.authJson === null)
    ) {
      return { owner: 'system-default', authJson: provenance.authJson }
    }
    if (
      provenance.owner !== 'managed' ||
      typeof provenance.accountId !== 'string' ||
      provenance.accountId.length === 0
    ) {
      return null
    }
    const baseline = this.parseSystemDefaultBaseline(provenance.systemDefaultBaseline)
    if ('systemDefaultBaseline' in provenance && !baseline) {
      return null
    }
    return {
      owner: 'managed',
      accountId: provenance.accountId,
      ...(baseline ? { systemDefaultBaseline: baseline } : {})
    }
  }

  private parseSystemDefaultBaseline(value: unknown): { authJson: string | null } | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null
    }
    const baseline = value as Record<string, unknown>
    return typeof baseline.authJson === 'string' || baseline.authJson === null
      ? { authJson: baseline.authJson }
      : null
  }

  private parsePendingSharedRuntimeAuthProvenance(
    value: unknown
  ): CodexSharedRuntimeAuthPendingProvenance | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null
    }
    const pending = value as Record<string, unknown>
    const next = this.parseSharedRuntimeAuthProvenance(pending.next)
    return pending.owner === 'pending' &&
      next &&
      (typeof pending.runtimeAuthJson === 'string' || pending.runtimeAuthJson === null)
      ? { owner: 'pending', next, runtimeAuthJson: pending.runtimeAuthJson }
      : null
  }

  private readRuntimeAuthForProvenance(): string | null {
    try {
      return readFileSync(this.getRuntimeAuthPath(), 'utf-8')
    } catch {
      return null
    }
  }

  private readSystemDefaultSnapshot(snapshotPath: string): CodexSystemDefaultSnapshot | null {
    let rawContents: string
    try {
      rawContents = readFileSync(snapshotPath, 'utf-8')
    } catch {
      return null
    }
    try {
      const parsed = JSON.parse(rawContents) as unknown
      if (
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        'authJson' in parsed &&
        (typeof (parsed as { authJson: unknown }).authJson === 'string' ||
          (parsed as { authJson: unknown }).authJson === null)
      ) {
        return parsed as CodexSystemDefaultSnapshot
      }
      // Why: pre-PR snapshots stored raw auth.json; treat objects lacking an authJson wrapper as legacy so upgraders don't lose their auth.
      if (
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        !('authJson' in parsed)
      ) {
        return { authJson: rawContents }
      }
    } catch {
      return null
    }
    return null
  }

  clearSystemDefaultSnapshot(): void {
    rmSync(this.getSystemDefaultSnapshotPath(), { force: true })
  }
}

// Why: Codex reads this config inside WSL, so relative path settings must anchor to the Linux-side home (verbatim copy breaks load, os error 2).
export function prepareWslRuntimeSeedConfig(
  configContents: string,
  sourceHomePath: string
): string {
  return prepareSystemConfigForFreshRuntimeMirror(
    configContents,
    parseWslUncPath(sourceHomePath)?.linuxPath ?? sourceHomePath
  )
}
