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
import type { Store } from '../persistence'
import { WSL_CODEX_RUNTIME_HOME_SEGMENTS } from '../pty/codex-home-wsl-env'
import { writeFileAtomically } from './fs-utils'
import {
  getOrcaManagedCodexHomePath,
  getCodexSessionBackfillStateDirPath,
  getSystemCodexHomePath,
  syncCodexGlobalInstructionsIntoManagedHome,
  syncSystemCodexResourcesIntoManagedHome
} from '../codex/codex-home-paths'
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
import { isCodexSystemDefaultRealHomeEnabled } from '../codex/codex-real-home-flag'
import { hasCustomCodexHomeOverride } from '../codex/codex-real-home-path'
import { invalidateCodexSessionBackfillMarker } from '../codex/codex-session-backfill-marker'
import { readShellStartupEnvVar } from '../pty/shell-startup-env'
import { assertOwnedHostCodexManagedHomePath } from './host-codex-managed-home-ownership'
import {
  codexAuthIsFresher,
  codexAuthMatchesManagedAccount,
  codexAuthMatchesSystemDefaultIdentity
} from './codex-auth-identity'
import { migrateLegacySharedAuthToPerAccountHome } from './legacy-shared-auth-migration'

type CodexSystemDefaultSnapshot = {
  authJson: string | null
}

type CodexRuntimeLogoutMarker = {
  systemDefaultAuthJson: string | null
  loggedOutAt: number
}

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

function readLaunchEnvValue(
  launchEnv: NodeJS.ProcessEnv,
  key: 'CODEX_HOME' | 'ORCA_CODEX_HOME' | 'HOME' | 'SHELL'
): string | undefined {
  return Object.prototype.hasOwnProperty.call(launchEnv, key) ? launchEnv[key] : process.env[key]
}

function getEffectiveCodexHomeEnv(launchEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    CODEX_HOME: readLaunchEnvValue(launchEnv, 'CODEX_HOME'),
    ORCA_CODEX_HOME: readLaunchEnvValue(launchEnv, 'ORCA_CODEX_HOME')
  }
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
  // Why: a flag-ON host account refreshes auth in its own home. Remember that
  // provenance so a later deselect/rollback never adopts stale shared bytes.
  private lastHostAccountUsedSelfContainedHome = false

  constructor(private readonly store: Store) {
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
    launchEnv?: NodeJS.ProcessEnv
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
      const perAccountHome = this.prepareSelfContainedManagedHomeForLaunch(selfContainedAccount)
      if (perAccountHome) {
        return perAccountHome
      }
      // Why: the account's home lost its auth.json, so the selection was just
      // dropped. Fall through and resolve this launch as the system default.
    }
    if (this.isHostSystemDefaultRealHome(launchEnv)) {
      // Why (flag ON, system default): run Codex on the user's own ~/.codex.
      // Returning null tells the PTY/env layer to inject no managed CODEX_HOME;
      // sessions, auth, and config all live in the native home. No system->
      // managed session bridge runs, so the real home stays the single source.
      return null
    }
    this.invalidateBackfillAfterManagedSystemDefaultLaunch(launchEnv)
    this.syncForCurrentSelection()
    syncSystemCodexResourcesIntoManagedHome()
    syncSystemConfigIntoManagedCodexHome()
    // Why: sessions can be large; bridge them after launch so starting a fresh TUI never waits on a full tree walk.
    void startSystemCodexSessionBridgeInBackground(
      {},
      resolveHostCodexSessionSourceHome(this.store.getSettings())
    )
    return this.getRuntimeHomePath()
  }

  // Why: with the real-home flag ON, a managed HOST account runs against its own
  // self-contained CODEX_HOME (codex-accounts/<id>/home) instead of the shared
  // runtime mirror. Its auth.json lives there and codex refreshes it in place,
  // so two accounts never race one auth.json (GAP-5) and the mirror can be
  // deleted once no lane still injects it (GAP-1). WSL accounts keep their
  // per-distro lane; the flag-OFF opt-out keeps the shared-home hot-swap.
  private getSelfContainedManagedHostAccount(): CodexManagedAccount | null {
    const settings = this.store.getSettings()
    if (!isCodexSystemDefaultRealHomeEnabled()) {
      return null
    }
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
  // they physically live. Flag ON makes every host managed home a live CODEX_HOME,
  // so scan them all. Flag OFF (opt-out/rollback) hands launches back to the shared
  // mirror, but a home that already accumulated rollouts while the flag was ON must
  // still surface them — otherwise opting out silently hides history that is safe on
  // disk. Gate the flag-OFF case on a sessions/ tree so a never-enabled install stays
  // byte-identical to today (its per-account homes hold only auth, no rollouts).
  private getManagedHostAccountHomesForSessionDiscovery(): string[] {
    const settings = this.store.getSettings()
    const flagEnabled = isCodexSystemDefaultRealHomeEnabled()
    const homes: string[] = []
    for (const account of settings.codexManagedAccounts) {
      if (this.getWslManagedHomePath(account)) {
        continue
      }
      const trustedHome = this.getTrustedSelfContainedManagedHomePath(account)
      if (trustedHome && (flagEnabled || existsSync(join(trustedHome, 'sessions')))) {
        homes.push(trustedHome)
      }
    }
    return homes
  }

  private prepareSelfContainedManagedHomeForLaunch(account: CodexManagedAccount): string | null {
    const perAccountHome = this.getTrustedSelfContainedManagedHomePath(account)
    if (!perAccountHome || !existsSync(join(perAccountHome, 'auth.json'))) {
      // Why: drop the selection so this and future launches resolve to the
      // system default rather than a home codex cannot authenticate against.
      this.clearSelfContainedManagedSelection(account)
      return null
    }
    // Why: link the user's real ~/.codex resources and mirror config into THIS
    // home (never symlinking into or mutating ~/.codex), so the per-account home
    // is a complete CODEX_HOME. Hooks/trust are installed by the launch caller.
    this.lastSyncedAccountId = account.id
    this.lastHostAccountUsedSelfContainedHome = true
    syncSystemCodexResourcesIntoManagedHome(perAccountHome)
    syncSystemConfigIntoManagedCodexHome({
      runtimeHomePath: perAccountHome,
      systemHomePath: getSystemCodexHomePath()
    })
    return perAccountHome
  }

  // Why: the per-account home is both the launch CODEX_HOME and the credential
  // store, so codex reads/refreshes auth.json in place — there is no shared-home
  // hot-swap or token read-back to reconcile. Only validate the credential
  // survives; a vanished auth.json drops the selection to the system default.
  private syncSelfContainedManagedSelection(account: CodexManagedAccount): void {
    const perAccountHome = this.getTrustedSelfContainedManagedHomePath(account)
    if (perAccountHome && existsSync(join(perAccountHome, 'auth.json'))) {
      this.lastSyncedAccountId = account.id
      this.lastHostAccountUsedSelfContainedHome = true
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

  private clearSelfContainedManagedSelection(account: CodexManagedAccount): void {
    console.warn(
      '[codex-runtime-home] Active managed account home is invalid or missing auth.json, clearing selection'
    )
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
    const realHomeSelected = this.isHostSystemDefaultRealHomeSelected(launchEnv)
    if (realHomeSelected || !isCodexSystemDefaultRealHomeEnabled()) {
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
    // Why: flag ON routes each managed host account to its own self-contained
    // home, so its rollouts live there rather than in the shared mirror. Scan
    // every such home — plus any that retained rollouts across an opt-out — so
    // account-scoped sessions still surface in the AI Vault.
    for (const perAccountHome of this.getManagedHostAccountHomesForSessionDiscovery()) {
      homes.push(perAccountHome)
    }
    return homes.filter((home, index) => homes.indexOf(home) === index)
  }

  // Why: the real-home hook installer flips this gate off when the trust-grant
  // client reports the host incapable, keeping that host byte-identical to the
  // managed lane instead of shipping status-blind panes.
  private realHomeLaneGate: () => boolean = () => true

  setRealHomeLaneGate(gate: () => boolean): void {
    this.realHomeLaneGate = gate
  }

  // Why: real-home routing applies only to the host system-default selection
  // with the staged flag ON. Managed accounts keep hot-swap isolation; custom
  // CODEX_HOMEs stay managed until phase 1 can track cleanup across old homes.
  isHostSystemDefaultRealHomeSelected(launchEnv?: NodeJS.ProcessEnv): boolean {
    const settings = this.store.getSettings()
    if (
      !isCodexSystemDefaultRealHomeEnabled() ||
      normalizeCodexRuntimeSelection(settings).host !== null
    ) {
      return false
    }
    // Why: PTY callers can overlay environment values that the Electron main
    // process never inherited. Those custom homes must keep the managed lane.
    const effectiveEnv = launchEnv ? getEffectiveCodexHomeEnv(launchEnv) : process.env
    if (hasCustomCodexHomeOverride(effectiveEnv)) {
      return false
    }
    // Why: Finder/Dock launches do not inherit shell exports, but the login
    // shell can re-export a custom home after spawn and bypass the trusted lane.
    const shellCodexHome = readShellStartupEnvVar(
      'CODEX_HOME',
      launchEnv ? readLaunchEnvValue(launchEnv, 'HOME') : process.env.HOME,
      launchEnv ? readLaunchEnvValue(launchEnv, 'SHELL') : process.env.SHELL
    )
    return !hasCustomCodexHomeOverride({ CODEX_HOME: shellCodexHome })
  }

  isHostSystemDefaultRealHome(launchEnv?: NodeJS.ProcessEnv): boolean {
    return this.isHostSystemDefaultRealHomeSelected(launchEnv) && this.realHomeLaneGate()
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
    if (
      selfContainedAccount &&
      selfContainedHome &&
      existsSync(join(selfContainedHome, 'auth.json'))
    ) {
      // Why: the quota fetch reads the account's own auth.json in place; no
      // shared-home hot-swap, and no per-poll resource relink (that is launch
      // prep). Config was mirrored on add/select and refreshed at launch.
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
      return getSystemCodexHomePath()
    }
    this.syncForCurrentSelection()
    syncSystemCodexResourcesIntoManagedHome()
    syncSystemConfigIntoManagedCodexHome()
    return this.getRuntimeHomePath()
  }

  syncForCurrentSelection(target?: CodexAccountSelectionTarget): void {
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
      // Why: E auth is already canonical in the per-account home. Reset the
      // legacy mirror baseline without reading it; flag-OFF can then seed the
      // mirror from canonical storage, while real-home deselect needs no sync.
      this.lastHostAccountUsedSelfContainedHome = false
      this.lastSyncedAccountId = null
      this.lastWrittenAuthJson = null
      if (this.isHostSystemDefaultRealHome()) {
        return
      }
    }
    const runtimeAuthExistedBeforeSync = existsSync(this.getRuntimeAuthPath())
    if (this.lastSyncedAccountId === null) {
      this.captureSystemDefaultSnapshot({ force: false })
    }
    const activeAccount = this.getActiveAccount(
      settings.codexManagedAccounts,
      normalizeCodexRuntimeSelection(settings).host
    )
    const previousAccount = this.getActiveAccount(
      settings.codexManagedAccounts,
      this.lastSyncedAccountId
    )
    if (this.getWslManagedHomePath(activeAccount)) {
      const previousWasHostManaged = previousAccount && !this.getWslManagedHomePath(previousAccount)
      const outgoingReadBackResult = previousWasHostManaged
        ? this.readBackRefreshedTokensForAccount(previousAccount, {
            updateLastWrittenAuthJson: false
          })
        : 'unchanged'
      if (previousWasHostManaged) {
        this.restoreSystemDefaultSnapshot({
          detectExternalLogin: outgoingReadBackResult !== 'rejected'
        })
      }
      this.lastSyncedAccountId = null
      this.lastWrittenAuthJson = null
      this.skipNextReadBackForAccountId = null
      return
    }
    let outgoingReadBackResult: CodexReadBackResult = 'unchanged'
    if (previousAccount && previousAccount.id !== activeAccount?.id) {
      outgoingReadBackResult = this.readBackRefreshedTokensForAccount(previousAccount, {
        updateLastWrittenAuthJson: true
      })
    }
    if (!activeAccount) {
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
        this.restoreSystemDefaultSnapshot({
          detectExternalLogin: outgoingReadBackResult !== 'rejected'
        })
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
      return
    }

    const activeAuthPath = join(activeAccount.managedHomePath, 'auth.json')
    if (!existsSync(activeAuthPath)) {
      console.warn(
        '[codex-runtime-home] Active managed account is missing auth.json, restoring system default'
      )
      if (this.lastSyncedAccountId === activeAccount.id) {
        outgoingReadBackResult = this.recoverRefreshForMissingActiveAccount(activeAccount)
      }
      this.store.updateSettings({
        activeCodexManagedAccountId: null,
        activeCodexManagedAccountIdsByRuntime: {
          ...normalizeCodexRuntimeSelection(settings),
          host: null
        }
      })
      if (this.lastSyncedAccountId !== null) {
        this.restoreSystemDefaultSnapshot({
          detectExternalLogin: outgoingReadBackResult !== 'rejected'
        })
        this.lastSyncedAccountId = null
      }
      return
    }

    if (this.lastSyncedAccountId === null) {
      this.captureSystemDefaultSnapshot({ force: true })
    }

    // Why: Codex refreshes OAuth tokens in the runtime auth.json; if it differs from Orca's last write, read those back to managed storage before overwriting.
    if (this.lastSyncedAccountId === activeAccount.id) {
      if (this.skipNextReadBackForAccountId === activeAccount.id) {
        this.skipNextReadBackForAccountId = null
      } else {
        this.readBackRefreshedTokens({
          updateLastWrittenAuthJson: true
        })
      }
    }

    if (this.lastSyncedAccountId !== activeAccount.id) {
      this.skipNextReadBackForAccountId = null
    }
    this.lastSyncedAccountId = activeAccount.id
    this.writeRuntimeAuth(readFileSync(activeAuthPath, 'utf-8'))
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

  private readBackRefreshedTokens(options: {
    updateLastWrittenAuthJson: boolean
  }): CodexReadBackResult {
    const selectedAccountId = normalizeCodexRuntimeSelection(this.store.getSettings()).host
    if (selectedAccountId) {
      const selectedAccountResult = this.readBackRefreshedTokensFromPath(
        this.getRuntimeAuthPath(),
        {
          ...options,
          expectedAccountId: selectedAccountId
        }
      )
      if (selectedAccountResult !== 'rejected') {
        return selectedAccountResult
      }
    }

    return this.readBackRefreshedTokensFromPath(this.getRuntimeAuthPath(), options)
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

  private readBackRefreshedTokensForAccount(
    account: CodexManagedAccount,
    options: { updateLastWrittenAuthJson: boolean }
  ): CodexReadBackResult {
    return this.readBackRefreshedTokensFromPath(this.getRuntimeAuthPath(), {
      ...options,
      expectedAccountId: account.id
    })
  }

  private recoverRefreshForMissingActiveAccount(account: CodexManagedAccount): CodexReadBackResult {
    try {
      const runtimeAuthPath = this.getRuntimeAuthPath()
      if (!existsSync(runtimeAuthPath) || this.lastWrittenAuthJson === null) {
        return 'rejected'
      }
      const runtimeContents = readFileSync(runtimeAuthPath, 'utf-8')
      if (runtimeContents === this.lastWrittenAuthJson) {
        return 'unchanged'
      }
      // Why: the canonical file is gone, so the exact in-memory bytes Orca
      // previously mirrored are the only safe identity baseline for recovery.
      if (!codexAuthMatchesManagedAccount(runtimeContents, account, this.lastWrittenAuthJson)) {
        return 'rejected'
      }
      writeFileAtomically(join(account.managedHomePath, 'auth.json'), runtimeContents, {
        mode: 0o600
      })
      this.lastWrittenAuthJson = runtimeContents
      return 'persisted'
    } catch (error) {
      console.warn('[codex-runtime-home] Failed to recover missing managed auth:', error)
      return 'rejected'
    }
  }

  private safeSyncForCurrentSelection(): void {
    try {
      this.syncForCurrentSelection()
    } catch (error) {
      console.warn('[codex-runtime-home] Failed to sync runtime auth state:', error)
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
    for (const account of this.store.getSettings().codexManagedAccounts) {
      if (expectedAccountId && account.id !== expectedAccountId) {
        continue
      }
      const managedAuthPath = join(account.managedHomePath, 'auth.json')
      if (!existsSync(managedAuthPath)) {
        continue
      }
      const managedAuthContents = readFileSync(managedAuthPath, 'utf-8')
      if (codexAuthMatchesManagedAccount(runtimeAuthContents, account, managedAuthContents)) {
        matches.push({ account, managedAuthPath, managedAuthContents })
      }
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
    if (!isCodexSystemDefaultRealHomeEnabled()) {
      return
    }
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

  private getRuntimeAuthPath(): string {
    return join(this.getRuntimeHomePath(), 'auth.json')
  }

  private getSystemDefaultSnapshotPath(): string {
    return join(this.getRuntimeMetadataDir(), 'system-default-auth.json')
  }

  private getRuntimeLogoutMarkerPath(): string {
    return join(this.getRuntimeMetadataDir(), 'system-default-runtime-logout.json')
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
      if (!existsSync(systemDefaultAuthPath)) {
        const snapshot = this.readSystemDefaultSnapshot(this.getSystemDefaultSnapshotPath())
        const mirroredSystemDefaultAuth = this.lastWrittenAuthJson ?? snapshot?.authJson ?? null
        if (mirroredSystemDefaultAuth !== null && runtimeAuth === mirroredSystemDefaultAuth) {
          this.clearRuntimeAuthAfterSystemDefaultLogout(runtimeAuthPath)
          return
        }
        if (
          mirroredSystemDefaultAuth !== null &&
          this.runtimeAuthMatchesSystemDefaultIdentity(runtimeAuth, mirroredSystemDefaultAuth)
        ) {
          this.clearRuntimeAuthAfterSystemDefaultLogout(runtimeAuthPath)
        }
        return
      }
      const systemDefaultAuth = readFileSync(systemDefaultAuthPath, 'utf-8')
      if (runtimeAuth !== systemDefaultAuth) {
        const snapshot = this.readSystemDefaultSnapshot(this.getSystemDefaultSnapshotPath())
        const mirroredSystemDefaultAuth = this.lastWrittenAuthJson ?? snapshot?.authJson ?? null
        if (
          mirroredSystemDefaultAuth !== null &&
          systemDefaultAuth === mirroredSystemDefaultAuth &&
          this.runtimeAuthMatchesSystemDefaultIdentity(runtimeAuth, mirroredSystemDefaultAuth)
        ) {
          // Why: Codex refreshes tokens in the runtime CODEX_HOME; read that back to ~/.codex so the next sync won't clobber fresh creds with stale ones.
          this.writeSystemDefaultAuth(runtimeAuth)
          this.captureSystemDefaultSnapshot({ force: true })
          this.lastWrittenAuthJson = runtimeAuth
          return
        }
        // Why: mirror external logins/logouts into Orca's runtime home so unmanaged Codex sessions keep matching the current system-default state.
        this.captureSystemDefaultSnapshot({ force: true })
        this.writeRuntimeAuth(systemDefaultAuth)
      }
    } catch (error) {
      console.warn('[codex-runtime-home] Failed to sync system-default auth:', error)
    }
  }

  private restoreSystemDefaultSnapshot(options: { detectExternalLogin: boolean }): void {
    const snapshotPath = this.getSystemDefaultSnapshotPath()
    const runtimeAuthPath = this.getRuntimeAuthPath()
    const systemDefaultAuthPath = join(getSystemCodexHomePath(), 'auth.json')
    if (existsSync(systemDefaultAuthPath)) {
      const systemDefaultAuth = readFileSync(systemDefaultAuthPath, 'utf-8')
      this.captureSystemDefaultSnapshot({ force: true })
      this.writeRuntimeAuth(systemDefaultAuth)
      return
    }

    if (options.detectExternalLogin && !existsSync(runtimeAuthPath)) {
      // Why: with Orca owning CODEX_HOME, a deleted runtime auth.json is a local logout, not a cue to restore the user's real ~/.codex snapshot.
      this.persistRuntimeLogoutMarker()
      this.lastWrittenAuthJson = null
      return
    }

    if (options.detectExternalLogin) {
      // Why: if ~/.codex/auth.json vanished while a managed account was selected, switching back must preserve that external system-default logout.
      rmSync(runtimeAuthPath, { force: true })
      this.captureSystemDefaultSnapshot({ force: true })
      this.persistRuntimeLogoutMarker()
      this.lastWrittenAuthJson = null
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
        return
      }
      if (refreshedSnapshot.authJson === null) {
        rmSync(runtimeAuthPath, { force: true })
        this.lastWrittenAuthJson = null
        return
      }
      this.writeRuntimeAuth(refreshedSnapshot.authJson)
      return
    }
    if (snapshot.authJson === null) {
      rmSync(runtimeAuthPath, { force: true })
      this.lastWrittenAuthJson = null
      return
    }
    this.writeRuntimeAuth(snapshot.authJson)
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
  }

  private readSystemDefaultAuth(): string | null {
    const systemDefaultAuthPath = join(getSystemCodexHomePath(), 'auth.json')
    return existsSync(systemDefaultAuthPath) ? readFileSync(systemDefaultAuthPath, 'utf-8') : null
  }

  private writeRuntimeAuth(contents: string): void {
    // Why: auth.json holds credentials; restrict to owner-only so other users on a shared machine cannot read it.
    this.clearRuntimeLogoutMarker()
    if (this.fileContentsEqual(this.getRuntimeAuthPath(), contents)) {
      this.ensureOwnerOnlyMode(this.getRuntimeAuthPath())
      this.lastWrittenAuthJson = contents
      return
    }
    writeFileAtomically(this.getRuntimeAuthPath(), contents, { mode: 0o600 })
    this.lastWrittenAuthJson = contents
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
