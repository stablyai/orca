/* eslint-disable max-lines -- Why: this service owns the single runtime-home
contract for Codex inside Orca. Keeping path resolution, system-default
snapshots, auth materialization, and recovery together prevents account-switch
semantics from drifting across PTY launch, login, and quota fetch paths. */
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
  getSystemCodexHomePath,
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

type CodexAuthIdentity = {
  email: string | null
  providerAccountId: string | null
  workspaceAccountId: string | null
}

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

export class CodexRuntimeHomeService {
  // Why: tracks whether the runtime auth.json currently mirrors a managed
  // account. When null, runtime auth follows the user's system-default
  // ~/.codex/auth.json instead of being written back to a managed account.
  private lastSyncedAccountId: string | null = null
  // Why: tracks the auth.json content Orca last wrote to the runtime CODEX_HOME.
  // Between syncs, if the file differs, Codex CLI refreshed the token — so
  // Orca writes back the refreshed token to managed storage before overwriting.
  // On managed→system-default transition, if the file differs, an external
  // login (e.g. `codex auth login`) overwrote it — so Orca adopts the file as
  // the new system default instead of restoring a stale snapshot.
  private lastWrittenAuthJson: string | null = null
  // Why: WSL terminals have their own stable runtime homes per distro. They
  // cannot share the host baseline or host sync can make stale WSL auth look
  // newer than managed storage.
  private readonly lastWrittenWslAuthJsonByDistro = new Map<string, string | null>()
  private readonly lastSyncedWslAccountIdByDistro = new Map<string, string | null>()
  private readonly wslRuntimeHomePathByDistro = new Map<string, string>()
  private skipNextReadBackForAccountId: string | null = null

  constructor(private readonly store: Store) {
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
    // Why: WSL-managed homes are never materialized into host ~/.codex.
    // Treating one as "last synced" makes cold start look like a host-account
    // transition and can restore/delete host auth that Orca never touched.
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
  prepareForCodexLaunch(target?: CodexAccountSelectionTarget): string | null {
    if (target?.runtime === 'wsl') {
      const wslTarget = this.resolveWslDefaultTarget(target)
      const syncedRuntimeHomePath = this.syncWslRuntimeForCurrentSelection(wslTarget)
      this.syncWslConfigSettingsForLaunch(wslTarget, syncedRuntimeHomePath)
      const runtimeHomePath = syncedRuntimeHomePath ?? this.getWslSystemCodexHomePath(wslTarget)
      this.startWslSessionBridgeForLaunch(wslTarget, runtimeHomePath)
      return runtimeHomePath
    }
    this.syncForCurrentSelection()
    syncSystemCodexResourcesIntoManagedHome()
    syncSystemConfigIntoManagedCodexHome()
    // Why: historical Codex sessions can be large; bridge them after launch
    // setup so starting a fresh Codex TUI never waits on a full tree walk.
    void startSystemCodexSessionBridgeInBackground(
      {},
      resolveHostCodexSessionSourceHome(this.store.getSettings())
    )
    return this.getRuntimeHomePath()
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
    // Why: history-only override lets custom-CODEX_HOME users bridge from their
    // real home; falls back to <wslHome>/.codex, which auth/config still use.
    const systemCodexHomePath =
      resolveWslCodexSessionSourceHome(this.store.getSettings(), distro) ??
      this.getWslSystemCodexHomePath({ runtime: 'wsl', wslDistro: distro })
    if (!systemCodexHomePath || systemCodexHomePath === runtimeHomePath) {
      return
    }
    // Why: WSL history must be hardlinked inside the distro; host-side links
    // cannot bridge Windows and WSL filesystems in a resume-visible way.
    void startWslCodexSessionBridgeInBackground({
      distro,
      systemCodexHomePath,
      managedCodexHomePath: runtimeHomePath
    })
  }

  getHostRuntimeHomePath(): string {
    return this.getRuntimeHomePath()
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

  // Why: WSL needs the same promote-then-mirror transaction as host. It keeps
  // in-Orca changes while reconciling a newer external ~/.codex edit before
  // advancing the per-distro baseline. Only runs on a materialized runtime.
  private syncWslConfigSettingsForLaunch(
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
    syncSystemConfigIntoManagedCodexHome({ runtimeHomePath, systemHomePath })
  }

  prepareForRateLimitFetch(target?: CodexAccountSelectionTarget): string | null {
    if (target?.runtime === 'wsl') {
      const wslTarget = this.resolveWslDefaultTarget(target)
      const syncedRuntimeHomePath = this.getPreparedWslRateLimitHomePath(wslTarget)
      return syncedRuntimeHomePath ?? this.getWslSystemCodexHomePath(wslTarget)
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

    const settings = this.store.getSettings()
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
      // Why: only restore the system-default mirror when transitioning FROM a
      // managed account. When no managed account was ever active, later syncs
      // should mirror the user's current ~/.codex/auth.json instead of
      // replaying an old snapshot on every PTY launch / rate-limit fetch.
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
          // Why: a real ~/.codex logout after a local runtime logout should
          // keep runtime auth absent instead of restoring the stale snapshot.
          this.captureSystemDefaultSnapshot({ force: true })
          this.persistRuntimeLogoutMarker(null)
          this.lastWrittenAuthJson = null
        } else if (this.lastWrittenAuthJson === null) {
          // Why: Orca-launched Codex sessions now use an Orca-owned CODEX_HOME
          // even when no managed account is selected. Seed that runtime home
          // from the user's current system-default auth once so dev/prod Orca
          // terminals stay logged in without mutating ~/.codex on startup.
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
      this.store.updateSettings({
        activeCodexManagedAccountId: null,
        activeCodexManagedAccountIdsByRuntime: {
          ...normalizeCodexRuntimeSelection(settings),
          host: null
        }
      })
      if (this.lastSyncedAccountId !== null) {
        this.restoreSystemDefaultSnapshot({ detectExternalLogin: true })
        this.lastSyncedAccountId = null
      }
      return
    }

    if (this.lastSyncedAccountId === null) {
      this.captureSystemDefaultSnapshot({ force: true })
    }

    // Why: Codex CLI refreshes expired OAuth tokens in CODEX_HOME/auth.json.
    // If we detect the runtime file differs from what Orca last wrote, the CLI
    // must have refreshed — so we preserve those tokens back to managed
    // storage before overwriting runtime with managed state.
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

  // Why: called by CodexAccountService before syncForCurrentSelection() after
  // re-auth or add-account. Those flows write fresh tokens to managed storage,
  // so the read-back must be skipped to avoid overwriting them with stale
  // runtime tokens.
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
      // Why: after app restart, Orca has no last-written baseline. Identity
      // alone cannot prove runtime auth is newer than managed storage.
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
      // Why: read-back is best-effort. A transient fs error must not block the
      // forward sync path — the worst case is one more stale-token cycle, which
      // is strictly better than failing the entire sync.
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
        // Why: the system-default account changes outside Orca (login, logout,
        // token refresh). Read its real home directly so a cached runtime copy
        // cannot stay stale; filesystem probing in the fetcher is asynchronous.
        return this.getWslSystemCodexHomePath(target)
      }
      const cachedRuntimeHomePath = this.wslRuntimeHomePathByDistro.get(distro)
      if (
        cachedRuntimeHomePath &&
        this.lastSyncedWslAccountIdByDistro.has(distro) &&
        this.lastSyncedWslAccountIdByDistro.get(distro) === selectedAccountId
      ) {
        // Why: RateLimitService resolves provenance twice per poll. Account
        // changes sync explicitly, so repeated resolution must stay path-only
        // instead of blocking main on UNC reads and a wsl.exe migration probe.
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
        // Why: WSL runtime homes are per-distro and their in-memory baseline is
        // lost on app restart. A same-identity fresher runtime auth is a Codex
        // token refresh and should be copied back before we mirror ~/.codex.
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
    // Why: WSL drops bash argv here and login-shell cleanup can turn explicit
    // `exit 0` into status 1, so keep this script literal and fall-through.
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
      if (this.runtimeAuthMatchesAccount(runtimeAuthContents, account, managedAuthContents)) {
        matches.push({ account, managedAuthPath, managedAuthContents })
      }
    }

    if (matches.length === 1) {
      return { kind: 'matched', ...matches[0] }
    }
    return { kind: matches.length === 0 ? 'none' : 'ambiguous' }
  }

  private runtimeAuthMatchesAccount(
    runtimeAuthContents: string,
    activeAccount: CodexManagedAccount,
    managedAuthContents: string
  ): boolean {
    const identity = this.readIdentityFromAuthContents(runtimeAuthContents)
    if (!identity) {
      return false
    }
    const managedIdentity = this.readIdentityFromAuthContents(managedAuthContents)

    // Why: old live Codex PTYs can still write refreshed tokens into the
    // shared runtime home after the user switches accounts. Never persist
    // that write into the newly active managed account unless the auth claims
    // still match the account Orca believes is selected.
    const selectedEmail = this.firstNonNull(
      this.normalizeField(activeAccount.email),
      managedIdentity?.email
    )
    const selectedProviderId = this.firstNonNull(
      this.normalizeField(activeAccount.providerAccountId),
      managedIdentity?.providerAccountId
    )
    const selectedWorkspaceId = this.firstNonNull(
      this.normalizeField(activeAccount.workspaceAccountId),
      managedIdentity?.workspaceAccountId
    )
    const emailMatches = Boolean(
      selectedEmail && identity.email && selectedEmail === identity.email
    )
    if (selectedEmail && identity.email && selectedEmail !== identity.email) {
      return false
    }
    if (!this.identityFieldMatches(selectedProviderId, identity.providerAccountId)) {
      return false
    }
    if (!this.identityFieldMatches(selectedWorkspaceId, identity.workspaceAccountId)) {
      return false
    }

    const hasStrongIdentity = Boolean(
      (selectedProviderId && identity.providerAccountId) ||
      (selectedWorkspaceId && identity.workspaceAccountId)
    )
    return (
      hasStrongIdentity ||
      (emailMatches && !identity.providerAccountId && !identity.workspaceAccountId)
    )
  }

  private runtimeAuthMatchesSystemDefaultIdentity(
    runtimeAuthContents: string,
    systemDefaultAuthContents: string
  ): boolean {
    const runtimeIdentity = this.readIdentityFromAuthContents(runtimeAuthContents)
    const systemDefaultIdentity = this.readIdentityFromAuthContents(systemDefaultAuthContents)
    if (!runtimeIdentity || !systemDefaultIdentity) {
      return false
    }

    // Why: stale managed Codex PTYs share the same runtime home. Only read a
    // runtime refresh back into ~/.codex when the auth still claims the same
    // system-default identity Orca mirrored earlier.
    if (
      systemDefaultIdentity.email &&
      runtimeIdentity.email &&
      systemDefaultIdentity.email !== runtimeIdentity.email
    ) {
      return false
    }
    if (
      !this.identityFieldMatches(
        systemDefaultIdentity.providerAccountId,
        runtimeIdentity.providerAccountId
      )
    ) {
      return false
    }
    if (
      !this.identityFieldMatches(
        systemDefaultIdentity.workspaceAccountId,
        runtimeIdentity.workspaceAccountId
      )
    ) {
      return false
    }

    const strongIdentityMatches = Boolean(
      (systemDefaultIdentity.providerAccountId && runtimeIdentity.providerAccountId) ||
      (systemDefaultIdentity.workspaceAccountId && runtimeIdentity.workspaceAccountId)
    )
    const emailMatches = Boolean(
      systemDefaultIdentity.email &&
      runtimeIdentity.email &&
      systemDefaultIdentity.email === runtimeIdentity.email
    )
    return (
      strongIdentityMatches ||
      (emailMatches && !runtimeIdentity.providerAccountId && !runtimeIdentity.workspaceAccountId)
    )
  }

  private runtimeAuthIsFresher(runtimeAuthContents: string, managedAuthContents: string): boolean {
    const runtimeFreshness = this.readFreshnessFromAuthContents(runtimeAuthContents)
    const managedFreshness = this.readFreshnessFromAuthContents(managedAuthContents)
    return (
      runtimeFreshness !== null && managedFreshness !== null && runtimeFreshness > managedFreshness
    )
  }

  private identityFieldMatches(selectedField: string | null, runtimeField: string | null): boolean {
    return !selectedField || Boolean(runtimeField && selectedField === runtimeField)
  }

  private firstNonNull(...values: (string | null | undefined)[]): string | null {
    return values.find((value): value is string => Boolean(value)) ?? null
  }

  private readIdentityFromAuthContents(contents: string): CodexAuthIdentity | null {
    let raw: Record<string, unknown>
    try {
      raw = JSON.parse(contents) as Record<string, unknown>
    } catch {
      return null
    }

    const tokens = this.readRecordClaim(raw, 'tokens')
    const idToken = this.normalizeField(
      this.readStringClaim(tokens, 'id_token') ?? this.readStringClaim(tokens, 'idToken')
    )
    const payload = idToken ? this.parseJwtPayload(idToken) : null
    const authClaims = this.readRecordClaim(payload, 'https://api.openai.com/auth')
    const profileClaims = this.readRecordClaim(payload, 'https://api.openai.com/profile')

    return {
      email: this.normalizeField(
        this.readStringClaim(payload, 'email') ?? this.readStringClaim(profileClaims, 'email')
      ),
      providerAccountId: this.normalizeField(
        this.readStringClaim(tokens, 'account_id') ??
          this.readStringClaim(tokens, 'accountId') ??
          this.readStringClaim(authClaims, 'chatgpt_account_id') ??
          this.readStringClaim(payload, 'chatgpt_account_id')
      ),
      workspaceAccountId: this.normalizeField(
        this.readStringClaim(authClaims, 'workspace_account_id') ??
          this.readStringClaim(tokens, 'account_id') ??
          this.readStringClaim(tokens, 'accountId') ??
          this.readStringClaim(payload, 'chatgpt_account_id')
      )
    }
  }

  private readFreshnessFromAuthContents(contents: string): number | null {
    let raw: Record<string, unknown>
    try {
      raw = JSON.parse(contents) as Record<string, unknown>
    } catch {
      return null
    }

    const tokens = this.readRecordClaim(raw, 'tokens')
    const idToken = this.normalizeField(
      this.readStringClaim(tokens, 'id_token') ?? this.readStringClaim(tokens, 'idToken')
    )
    const payload = idToken ? this.parseJwtPayload(idToken) : null
    return (
      this.readNumberClaim(tokens, 'expires_at') ??
      this.readNumberClaim(tokens, 'expiresAt') ??
      this.readNumberClaim(tokens, 'expiry') ??
      this.readNumberClaim(tokens, 'expires') ??
      this.readNumberClaim(payload, 'exp') ??
      this.readNumberClaim(payload, 'iat')
    )
  }

  private parseJwtPayload(token: string): Record<string, unknown> | null {
    const parts = token.split('.')
    if (parts.length < 2) {
      return null
    }

    let payload = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    while (payload.length % 4 !== 0) {
      payload += '='
    }

    try {
      const json = Buffer.from(payload, 'base64').toString('utf-8')
      return JSON.parse(json) as Record<string, unknown>
    } catch {
      return null
    }
  }

  private readRecordClaim(
    value: Record<string, unknown> | null,
    key: string
  ): Record<string, unknown> | null {
    const claim = value?.[key]
    if (!claim || typeof claim !== 'object' || Array.isArray(claim)) {
      return null
    }
    return claim as Record<string, unknown>
  }

  private readStringClaim(value: Record<string, unknown> | null, key: string): string | null {
    const claim = value?.[key]
    return typeof claim === 'string' ? claim : null
  }

  private readNumberClaim(value: Record<string, unknown> | null, key: string): number | null {
    const claim = value?.[key]
    if (typeof claim === 'number' && Number.isFinite(claim)) {
      return claim
    }
    if (typeof claim === 'string') {
      const parsed = Number(claim)
      return Number.isFinite(parsed) ? parsed : null
    }
    return null
  }

  private normalizeField(value: string | null | undefined): string | null {
    if (!value) {
      return null
    }
    const trimmed = value.trim()
    return trimmed === '' ? null : trimmed
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

    // Why: migration is intentionally one-shot. Re-importing every startup
    // would keep replaying stale managed-home state back into the shared
    // runtime and make it feel nondeterministic.
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
    // Why: migrating legacy session trees must tolerate directories larger than
    // V8's argument limit for spread calls.
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
      // Why: conflict diagnostics are useful, but must not make the one-shot
      // migration fail after the session file has already been preserved.
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
          // Why: system-default Codex now refreshes tokens inside Orca's
          // runtime CODEX_HOME. Read that refresh back to ~/.codex so the next
          // sync does not overwrite fresh runtime credentials with stale ones.
          this.writeSystemDefaultAuth(runtimeAuth)
          this.captureSystemDefaultSnapshot({ force: true })
          this.lastWrittenAuthJson = runtimeAuth
          return
        }
        // Why: the unmanaged path used to read ~/.codex directly. Mirror later
        // external logins/logouts into Orca's runtime home so ordinary Orca
        // Codex sessions keep matching the user's current system-default state.
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
      // Why: once Orca owns the runtime CODEX_HOME, deleting auth.json there is
      // a local logout signal for Orca-launched Codex sessions, not a reason to
      // rewrite the user's real ~/.codex snapshot back into place.
      this.persistRuntimeLogoutMarker()
      this.lastWrittenAuthJson = null
      return
    }

    if (options.detectExternalLogin) {
      // Why: while a managed account is selected, the runtime auth file exists
      // with managed credentials. If ~/.codex/auth.json vanished meanwhile,
      // switching back must preserve that external system-default logout.
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
    // Why: when the real ~/.codex auth disappears, Orca should treat that as an
    // external logout for unmanaged sessions, even if runtime auth had already
    // refreshed inside Orca's CODEX_HOME.
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
    // Why: auth.json contains sensitive credentials. Restrict to owner-only
    // so other users on a shared Linux/macOS machine cannot read it.
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
      // Why: pre-PR snapshots wrote raw auth.json contents verbatim. Treat any
      // valid JSON object without an authJson wrapper as the legacy format so
      // upgraders do not lose their system-default auth on first deselect.
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

// Why: the seed config is read over UNC but consumed by Codex inside WSL, so
// relative path-valued settings must anchor to the Linux-side source home; a
// verbatim copy breaks Codex config load (os error 2).
export function prepareWslRuntimeSeedConfig(
  configContents: string,
  sourceHomePath: string
): string {
  return prepareSystemConfigForFreshRuntimeMirror(
    configContents,
    parseWslUncPath(sourceHomePath)?.linuxPath ?? sourceHomePath
  )
}
