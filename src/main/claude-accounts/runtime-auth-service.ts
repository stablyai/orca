/* eslint-disable max-lines -- Why: keeps file/Keychain/snapshot/env-patch auth semantics together so PTY launch and quota-fetch paths can't drift. */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import type { ClaudeManagedAccount } from '../../shared/types'
import type { Store } from '../persistence'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import type { ClaudeEnvPatch } from './environment'
import {
  readClaudeManagedAuthFile,
  resolveOwnedClaudeManagedAuthPath,
  writeClaudeManagedAuthFile
} from './managed-auth-path'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { resolveLocalAccountRuntimeTarget } from '../../shared/local-account-runtime'
import { getDefaultWslDistro, toWindowsWslPath, wslUncFileExists } from '../wsl'
import { buildEncodedWslBashCommand } from '../wsl-bash-command'
import { hasLiveClaudePtys } from './live-pty-gate'
import { isOauthTokenExpiring, refreshClaudeOauthCredentials } from './oauth-refresh'
import {
  ClaudeRuntimePathResolver,
  resolveWslProfilePaths,
  type ClaudeRuntimePaths
} from './runtime-paths'
import {
  ClaudeAuthSurfaceStates,
  HOST_AUTH_SURFACE_KEY,
  authSurfaceSnapshotFileName,
  wslAuthSurfaceKey,
  type ClaudeAuthSurfaceState
} from './auth-surface'
import {
  deleteActiveClaudeKeychainCredentialsStrict,
  readActiveClaudeKeychainCredentials,
  readActiveClaudeKeychainCredentialsStrict,
  readManagedClaudeKeychainCredentials,
  writeActiveClaudeKeychainCredentials,
  writeActiveClaudeKeychainCredentialsForRuntime,
  writeManagedClaudeKeychainCredentials
} from './keychain'
import {
  getClaudeSelectionTargetForAccount,
  getSelectedClaudeAccountIdForTarget,
  normalizeClaudeAccountSelectionTarget,
  normalizeClaudeRuntimeSelection,
  setSelectedClaudeAccountIdForTarget,
  type ClaudeAccountSelectionTarget
} from './runtime-selection'

export type ClaudeRuntimeAuthPreparation = {
  configDir: string
  runtime?: 'host' | 'wsl'
  wslDistro?: string | null
  wslLinuxConfigDir?: string | null
  envPatch: ClaudeEnvPatch
  stripAuthEnv: boolean
  managedRefreshDeferredByLivePty?: boolean
  provenance: string
}

type ClaudeSystemDefaultSnapshot = {
  credentialsJson: string | null
  configOauthAccount: unknown
  keychainCredentialsJson: string | null
  scopedKeychainCredentialsJson?: string | null
  legacyKeychainCredentialsJson?: string | null
  scopedKeychainCredentialsCaptured?: boolean
  legacyKeychainCredentialsCaptured?: boolean
  // Why: the snapshot file outlives a restore (it is what keeps the original login recoverable), so
  // its existence proves nothing about ownership; this field is the explicit record of it.
  materializedAccountId?: string | null
  capturedAt: number
}

/**
 * A read of an auth-surface file. `unknown` means the answer could not be confirmed — Win32 reports
 * spurious ENOENT over the WSL 9P share — and every caller that feeds a snapshot or an ownership
 * decision must fail closed on it rather than fall through to "absent".
 */
type ClaudeSurfaceFileRead = { status: 'read'; contents: string | null } | { status: 'unknown' }

type ClaudeRuntimeConfigRead =
  | { status: 'read'; record: Record<string, unknown>; contents: string | null }
  | { status: 'invalid' }
  | { status: 'unknown' }

type ClaudeAuthIdentity = {
  accountUuid: string | null
  email: string | null
  organizationUuid: string | null
}

type ClaudeReadBackResult =
  | { status: 'unchanged' | 'persisted' }
  | {
      status: 'rejected'
      runtimeCredentialsChanged: boolean
      hasValidChangedRuntimeCredentials: boolean
      runtimeCredentialsJson?: string
    }
type ClaudeReadBackMatch =
  | { kind: 'matched'; account: ClaudeManagedAccount; managedCredentialsJson: string }
  | { kind: 'none' | 'ambiguous' }
type ClaudeKeychainReadResult =
  | { status: 'captured'; credentialsJson: string | null }
  | { status: 'failed' }
type ClaudeKeychainSnapshotValue =
  | { status: 'captured'; credentialsJson: string | null }
  | { status: 'unknown' }
type ClaudeRefreshTokenComparison = 'same' | 'different' | 'missing'
type ClaudeRuntimeCredentialCandidate = {
  credentialsJson: string
  runtimeOauthAccount: unknown
}

type ClaudeAuthSurface = {
  key: string
  state: ClaudeAuthSurfaceState
  getPaths: () => ClaudeRuntimePaths
}

type ClaudeWslMaterialization = {
  accountId: string
  configDir: string
  linuxConfigDir: string | null
}

const RUNTIME_OAUTH_ACCOUNT_PARSE_ERROR = Symbol('runtime-oauth-account-parse-error')
// Why: distinct from a parse error so only the WSL-9P case fails a snapshot closed; a corrupt host
// ~/.claude.json keeps its existing lenient handling.
const RUNTIME_OAUTH_ACCOUNT_UNREADABLE = Symbol('runtime-oauth-account-unreadable')

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

export class ClaudeRuntimeAuthService {
  private readonly pathResolver = new ClaudeRuntimePathResolver()
  private readonly surfaceStates = new ClaudeAuthSurfaceStates()
  private readonly wslMaterializations = new Map<string, ClaudeWslMaterialization>()
  // Why: ownership probes shell out to wsl.exe; one answer per account per mutation keeps a sync from spawning 2N processes.
  private readonly ownedManagedAuthPaths = new Map<string, string | null>()
  // Why: a heavy distro's ~/.claude.json is tens of MB over 9P and the sync consults it up to three
  // times; one read + one parse per serialized mutation, dropped at its start and refreshed on write.
  private cachedRuntimeConfigRead: { path: string; read: ClaudeRuntimeConfigRead } | null = null
  private readonly wslAbsentSurfaceFiles = new Map<string, boolean>()
  private mutationQueue: Promise<unknown> = Promise.resolve()
  private surface: ClaudeAuthSurface
  private managedRefreshDeferredByLivePtyAccountId: string | null = null

  constructor(private readonly store: Store) {
    this.surface = this.getHostSurface()
    void this.safeSyncForCurrentSelection()
  }

  async prepareForClaudeLaunch(
    target?: ClaudeAccountSelectionTarget
  ): Promise<ClaudeRuntimeAuthPreparation> {
    const effectiveTarget = target ?? this.getDefaultAccountSelectionTarget()
    await this.syncForCurrentSelection(effectiveTarget)
    return this.getPreparation(effectiveTarget)
  }

  async prepareForRateLimitFetch(
    target?: ClaudeAccountSelectionTarget
  ): Promise<ClaudeRuntimeAuthPreparation> {
    const effectiveTarget = target ?? this.getDefaultAccountSelectionTarget()
    await this.syncForCurrentSelection(effectiveTarget)
    return this.getPreparation(effectiveTarget)
  }

  async syncForCurrentSelection(target?: ClaudeAccountSelectionTarget): Promise<void> {
    await this.serializeMutation(() =>
      this.doSyncForCurrentSelection(target ?? this.getDefaultAccountSelectionTarget())
    )
  }

  async forceMaterializeCurrentSelectionForRollback(
    target?: ClaudeAccountSelectionTarget
  ): Promise<void> {
    await this.serializeMutation(async () => {
      const settings = this.store.getSettings()
      const effectiveTarget = this.resolveWslDefaultTarget(
        target ?? this.getDefaultAccountSelectionTarget(settings)
      )
      const normalizedTarget = normalizeClaudeAccountSelectionTarget(effectiveTarget)
      if (!getSelectedClaudeAccountIdForTarget(settings, normalizedTarget)) {
        const surface = this.resolveSurfaceForTarget(normalizedTarget)
        if (!surface) {
          return
        }
        this.surface = surface
        const previousAccount = this.getActiveAccount(
          settings.claudeManagedAccounts,
          this.surface.state.lastSyncedAccountId
        )
        await this.restoreSystemDefaultSnapshot(
          previousAccount ? await this.readManagedCredentials(previousAccount) : null,
          previousAccount ? this.readManagedOauthAccount(previousAccount) : undefined
        )
        this.setSurfaceLastSyncedAccountId(null)
        this.wslMaterializations.delete(this.surface.key)
        return
      }
      await this.doSyncForCurrentSelection(effectiveTarget)
    })
  }

  getRuntimeConfigDir(): string {
    return this.pathResolver.getRuntimePaths().configDir
  }

  private getHostSurface(): ClaudeAuthSurface {
    return {
      key: HOST_AUTH_SURFACE_KEY,
      // Why: every Orca version has materialized into the host ~/.claude, so a persisted host
      // selection is itself proof that Orca owns whatever sits there.
      state: this.surfaceStates.stateFor(HOST_AUTH_SURFACE_KEY, () =>
        getSelectedClaudeAccountIdForTarget(this.store.getSettings(), {
          runtime: 'host'
        })
      ),
      getPaths: () => this.pathResolver.getRuntimePaths()
    }
  }

  /**
   * Why: a distro profile was never written before #11824, so unlike the host surface a persisted
   * WSL selection proves nothing — and the snapshot file is deliberately kept after a restore, so its
   * existence proves nothing either. Ownership is claimed only when Orca explicitly recorded this
   * surface as materialized *and* the login sitting there still carries that account's identity; a
   * `/login` inside the distro while Orca was closed therefore re-enters as a fresh managed entry and
   * gets snapshotted before it is overwritten.
   */
  private seedWslLastSyncedAccountId(paths: ClaudeRuntimePaths): string | null {
    const snapshot = this.readSystemDefaultSnapshot(this.getSurfaceSnapshotPath(paths.surfaceKey))
    const materializedAccountId = snapshot?.materializedAccountId ?? null
    if (!materializedAccountId) {
      return null
    }
    const account = this.getActiveAccount(
      this.store.getSettings().claudeManagedAccounts,
      materializedAccountId
    )
    if (!account) {
      return null
    }
    const runtimeCredentials = this.readSurfaceFile(paths.credentialsPath, paths.surfaceKey)
    return runtimeCredentials.status === 'read' &&
      this.runtimeCredentialsBelongToAccount(
        runtimeCredentials.contents,
        account,
        this.readManagedOauthAccount(account)
      )
      ? materializedAccountId
      : null
  }

  private getWslSurface(distro: string | null): ClaudeAuthSurface | null {
    const trimmedDistro = distro?.trim()
    if (!trimmedDistro) {
      return null
    }
    const paths = resolveWslProfilePaths(trimmedDistro)
    if (!paths) {
      return null
    }
    return {
      key: paths.surfaceKey,
      state: this.surfaceStates.stateFor(paths.surfaceKey, () =>
        this.seedWslLastSyncedAccountId(paths)
      ),
      getPaths: () => paths
    }
  }

  // Why: null for an unreachable distro — nothing was materialized there, so nothing may be restored on its behalf.
  private resolveSurfaceForTarget(
    target: ReturnType<typeof normalizeClaudeAccountSelectionTarget>
  ): ClaudeAuthSurface | null {
    return target.runtime === 'wsl' ? this.getWslSurface(target.wslDistro) : this.getHostSurface()
  }

  private async safeSyncForCurrentSelection(): Promise<void> {
    try {
      await this.syncForCurrentSelection()
    } catch (error) {
      console.warn('[claude-runtime-auth] Failed to sync runtime auth state:', error)
    }
  }

  private serializeMutation<T>(fn: () => Promise<T>): Promise<T> {
    const run = (): Promise<T> => {
      this.ownedManagedAuthPaths.clear()
      this.wslAbsentSurfaceFiles.clear()
      this.cachedRuntimeConfigRead = null
      return fn()
    }
    const next = this.mutationQueue.then(run, run)
    this.mutationQueue = next.catch(() => {})
    return next
  }

  private async doSyncForCurrentSelection(target?: ClaudeAccountSelectionTarget): Promise<void> {
    const settings = this.store.getSettings()
    const effectiveTarget = this.resolveWslDefaultTarget(target)
    const normalizedTarget = normalizeClaudeAccountSelectionTarget(effectiveTarget)
    const activeAccountId = getSelectedClaudeAccountIdForTarget(settings, normalizedTarget)
    const activeAccount = this.getActiveAccount(settings.claudeManagedAccounts, activeAccountId)
    const wslSurface =
      normalizedTarget.runtime === 'wsl' ? this.getWslSurface(normalizedTarget.wslDistro) : null
    this.surface = wslSurface ?? this.getHostSurface()
    const state = this.surface.state
    const previousAccount = this.getActiveAccount(
      settings.claudeManagedAccounts,
      state.lastSyncedAccountId
    )
    this.managedRefreshDeferredByLivePtyAccountId = null
    const previousManagedCredentialsJson = previousAccount
      ? await this.readManagedCredentials(previousAccount)
      : null
    const previousManagedOauthAccount = previousAccount
      ? this.readManagedOauthAccount(previousAccount)
      : null
    if (previousAccount && previousAccount.id !== activeAccount?.id) {
      if (previousManagedCredentialsJson) {
        const outgoingReadBackResult = await this.readBackRefreshedTokens(
          previousManagedCredentialsJson,
          {
            updateLastWrittenCredentialsJson: true
          }
        )
        if (
          outgoingReadBackResult.status === 'rejected' &&
          outgoingReadBackResult.runtimeCredentialsChanged &&
          hasLiveClaudePtys()
        ) {
          if (
            outgoingReadBackResult.runtimeCredentialsJson &&
            (await this.liveRuntimeCredentialsCanUpdateActiveAccount(
              outgoingReadBackResult.runtimeCredentialsJson,
              previousAccount,
              previousManagedCredentialsJson,
              previousManagedOauthAccount
            ))
          ) {
            // Why: switching away while Claude is live must preserve verified token refreshes before replacing shared runtime credentials.
            await this.writeManagedCredentials(
              previousAccount,
              outgoingReadBackResult.runtimeCredentialsJson
            )
          } else {
            // Why: the runtime blob may lack identity proof for a live-session refresh; skip persisting it, but still let new terminals move to the account.
            console.warn(
              '[claude-runtime-auth] Skipping unverified live Claude auth read-back while switching accounts'
            )
          }
        }
      }
    }
    if (!activeAccount) {
      if (activeAccountId) {
        const nextSelection = setSelectedClaudeAccountIdForTarget(
          normalizeClaudeRuntimeSelection(settings),
          null,
          normalizedTarget
        )
        this.store.updateSettings({
          activeClaudeManagedAccountId:
            normalizedTarget.runtime === 'host' ? null : settings.activeClaudeManagedAccountId,
          activeClaudeManagedAccountIdsByRuntime: nextSelection
        })
      }
      if (normalizedTarget.runtime === 'wsl') {
        if (wslSurface && state.lastSyncedAccountId !== null) {
          // Why: deselecting a WSL account must hand the distro back its own login, not leave Orca's credentials pinned.
          await (previousAccount
            ? this.restoreSystemDefaultSnapshot(
                previousManagedCredentialsJson,
                previousManagedOauthAccount
              )
            : this.restoreSystemDefaultSnapshot(state.lastWrittenCredentialsJson, undefined))
          this.setSurfaceLastSyncedAccountId(null)
        }
        this.wslMaterializations.delete(this.surface.key)
        return
      }
      if (state.lastSyncedAccountId !== null) {
        await (previousAccount
          ? this.restoreSystemDefaultSnapshot(
              previousManagedCredentialsJson,
              previousManagedOauthAccount
            )
          : this.restoreSystemDefaultSnapshot(state.lastWrittenCredentialsJson, undefined))
        this.setSurfaceLastSyncedAccountId(null)
      }
      return
    }

    const wslManagedSurface = activeAccount.managedAuthRuntime === 'wsl' ? wslSurface : null
    const clearRuntimeScopedSelection = (): void => {
      this.store.updateSettings({
        activeClaudeManagedAccountId:
          normalizedTarget.runtime === 'host' ? null : settings.activeClaudeManagedAccountId,
        activeClaudeManagedAccountIdsByRuntime: setSelectedClaudeAccountIdForTarget(
          normalizeClaudeRuntimeSelection(settings),
          null,
          normalizedTarget
        )
      })
    }
    const clearInvalidManagedSelection = (): void => {
      if (normalizedTarget.runtime === 'wsl') {
        clearRuntimeScopedSelection()
        return
      }
      this.store.updateSettings({ activeClaudeManagedAccountId: null })
    }
    const restoreForInvalidManagedSelection = async (): Promise<void> => {
      if (state.lastSyncedAccountId === null) {
        return
      }
      if (
        previousAccount &&
        (previousAccount.id !== activeAccount.id ||
          state.hasMaterializedRuntimeAuth ||
          (await this.runtimeOauthAccountMatches(previousManagedOauthAccount)))
      ) {
        await this.restoreSystemDefaultSnapshotForMissingManagedCredentials(
          previousAccount,
          previousManagedOauthAccount
        )
      } else if (!previousAccount && state.hasMaterializedRuntimeAuth) {
        await this.restoreSystemDefaultSnapshot(state.lastWrittenCredentialsJson, undefined)
      }
    }

    if (activeAccount.managedAuthRuntime === 'wsl' && !wslManagedSurface) {
      if (!this.getOwnedManagedAuthPath(activeAccount)) {
        console.warn(
          '[claude-runtime-auth] Active WSL managed account is not owned by Orca, restoring system default'
        )
        clearRuntimeScopedSelection()
        return
      }
      const slotCredentialsJson = await this.readManagedCredentials(activeAccount)
      if (!slotCredentialsJson || !this.isValidCredentialsJsonObject(slotCredentialsJson)) {
        console.warn(
          '[claude-runtime-auth] Active WSL managed account is missing or has invalid credentials, restoring system default'
        )
        clearRuntimeScopedSelection()
        return
      }
      // Why: the distro is unreachable, so there is no profile to write into and the launch degrades to
      // the isolated slot. `this.surface` fell back to the host here, so its state must be left alone —
      // clearing it would strip the host's ownership proof and strand host credentials on deselect.
      if (activeAccount.wslDistro) {
        this.wslMaterializations.delete(wslAuthSurfaceKey(activeAccount.wslDistro))
      }
      return
    }

    if (!this.getOwnedManagedAuthPath(activeAccount)) {
      console.warn(
        '[claude-runtime-auth] Active managed account is not owned by Orca, restoring system default'
      )
      await restoreForInvalidManagedSelection()
      clearInvalidManagedSelection()
      this.setSurfaceLastSyncedAccountId(null)
      this.wslMaterializations.delete(this.surface.key)
      return
    }

    let credentialsJson = await this.readManagedCredentials(activeAccount)
    if (!credentialsJson || !this.isValidCredentialsJsonObject(credentialsJson)) {
      console.warn(
        '[claude-runtime-auth] Active managed account is missing or has invalid credentials, restoring system default'
      )
      await restoreForInvalidManagedSelection()
      clearInvalidManagedSelection()
      this.setSurfaceLastSyncedAccountId(null)
      this.wslMaterializations.delete(this.surface.key)
      return
    }

    if (state.lastSyncedAccountId === null) {
      if (
        (await this.captureSystemDefaultSnapshotForManagedEntry(credentialsJson)) !== 'captured'
      ) {
        // Why: with no confirmed copy of the distro's own login there is nothing to restore on
        // deselect, so leave the profile untouched and degrade to the isolated slot (pre-#11824
        // behaviour): correct identity, degraded profile, nothing destroyed.
        console.warn(
          '[claude-runtime-auth] Cannot read the WSL distro profile through the 9P share; leaving it untouched and launching against the isolated auth slot'
        )
        this.wslMaterializations.delete(this.surface.key)
        return
      }
    }

    // Why: the CLI writes refreshed tokens to .credentials.json; if runtime differs from our last write, preserve them to managed storage before overwriting.
    if (state.lastSyncedAccountId === activeAccount.id) {
      if (state.skipNextReadBackForAccountId === activeAccount.id) {
        state.skipNextReadBackForAccountId = null
      } else {
        const readBackResult = await this.readBackRefreshedTokens(credentialsJson, {
          updateLastWrittenCredentialsJson: true
        })
        if (readBackResult.status === 'persisted') {
          const updatedCredentialsJson = await this.readManagedCredentials(activeAccount)
          if (updatedCredentialsJson && this.isValidCredentialsJsonObject(updatedCredentialsJson)) {
            credentialsJson = updatedCredentialsJson
          }
        } else if (
          readBackResult.status === 'rejected' &&
          readBackResult.runtimeCredentialsChanged &&
          // Why: a live Claude that lost a refresh race can wipe its runtime blob (empty tokens); preserving that would log out every new session.
          readBackResult.hasValidChangedRuntimeCredentials &&
          hasLiveClaudePtys()
        ) {
          if (
            readBackResult.runtimeCredentialsJson &&
            (await this.liveRuntimeCredentialsCanUpdateActiveAccount(
              readBackResult.runtimeCredentialsJson,
              activeAccount,
              credentialsJson,
              this.readManagedOauthAccount(activeAccount)
            ))
          ) {
            // Why: this Claude launched under the active managed account, but persistence still needs positive account proof.
            await this.writeManagedCredentials(activeAccount, readBackResult.runtimeCredentialsJson)
            credentialsJson = readBackResult.runtimeCredentialsJson
          } else {
            // Why: while Claude runs, an unknown refresh may belong to a live session; rewriting stale managed auth logs it out.
            console.warn(
              '[claude-runtime-auth] Preserving changed Claude runtime credentials while live Claude terminals are running'
            )
            this.setSurfaceLastSyncedAccountId(activeAccount.id)
            state.hasMaterializedRuntimeAuth = true
            this.recordWslMaterialization(wslManagedSurface, activeAccount.id)
            return
          }
        }
      }
    }

    if (state.lastSyncedAccountId !== activeAccount.id) {
      state.skipNextReadBackForAccountId = null
    }

    // Why: rotate+persist the single-use token to managed storage before materializing (else runtime gets a stale token that fails invalid_grant); skip while a live PTY owns the creds since refreshing would double-rotate it (invalidating one copy) — read-back preserves its refresh instead.
    const liveClaudePtys = hasLiveClaudePtys()
    if (liveClaudePtys && isOauthTokenExpiring(credentialsJson)) {
      this.managedRefreshDeferredByLivePtyAccountId = activeAccount.id
    }
    if (!liveClaudePtys) {
      const refreshed = await this.refreshManagedAccountTokenIfNeeded(
        activeAccount,
        credentialsJson
      )
      if (refreshed) {
        credentialsJson = refreshed
      }
    }

    const paths = this.surface.getPaths()
    this.writeRuntimeCredentials(credentialsJson)
    if (this.isKeychainSurface()) {
      // Why: Claude Code 2.1+ reads the scoped service, older builds the legacy unsuffixed one; runtime switching must satisfy both.
      try {
        await writeActiveClaudeKeychainCredentialsForRuntime(credentialsJson, paths.configDir)
      } catch (error) {
        await this.restoreSystemDefaultSnapshot(
          credentialsJson,
          this.readManagedOauthAccount(activeAccount)
        )
        throw error
      }
    }
    const managedOauthAccount = this.readManagedOauthAccount(activeAccount)
    // Why: a distro's ~/.claude.json holds full project/MCP history and can be tens of MB; skip the
    // rewrite only when the file itself still carries this identity — a `/login` inside the distro
    // rewrites it behind Orca's back, so cached last-write bookkeeping is not proof. The read is
    // shared with the write below through the per-mutation cache, so it costs one read either way.
    const oauthAccountAlreadyWritten =
      this.surface.key !== HOST_AUTH_SURFACE_KEY &&
      (await this.runtimeOauthAccountMatches(managedOauthAccount))
    if (oauthAccountAlreadyWritten || (await this.writeRuntimeOauthAccount(managedOauthAccount))) {
      state.lastWrittenOauthAccount = managedOauthAccount
      state.hasLastWrittenOauthAccount = true
    } else {
      state.lastWrittenOauthAccount = null
      state.hasLastWrittenOauthAccount = false
    }
    this.setSurfaceLastSyncedAccountId(activeAccount.id)
    state.hasMaterializedRuntimeAuth = true
    this.recordWslMaterialization(wslManagedSurface, activeAccount.id)
  }

  /**
   * Why: the in-memory `lastSyncedAccountId` is the whole basis for "may Orca restore over this
   * profile?", and it has to survive a restart. Persisting it beside the snapshot makes ownership an
   * explicit fact instead of something inferred from a file existing.
   */
  private setSurfaceLastSyncedAccountId(accountId: string | null): void {
    this.surface.state.lastSyncedAccountId = accountId
    this.persistSurfaceMaterializedAccountId(accountId)
  }

  private persistSurfaceMaterializedAccountId(accountId: string | null): void {
    const snapshotPath = this.getSystemDefaultSnapshotPath()
    // Why: never conjure a snapshot here — one with a null `credentialsJson` would tell a later
    // restore that the surface had no login and delete the real one. Read without
    // `readSystemDefaultSnapshot` so recording ownership never prunes a snapshot as a side effect.
    let snapshot: ClaudeSystemDefaultSnapshot
    try {
      const parsed = JSON.parse(readFileSync(snapshotPath, 'utf-8')) as unknown
      if (!this.isSystemDefaultSnapshot(parsed)) {
        return
      }
      snapshot = parsed
    } catch {
      return
    }
    if ((snapshot.materializedAccountId ?? null) === accountId) {
      return
    }
    this.writeJson(snapshotPath, { ...snapshot, materializedAccountId: accountId })
  }

  private recordWslMaterialization(surface: ClaudeAuthSurface | null, accountId: string): void {
    if (!surface) {
      return
    }
    const paths = surface.getPaths()
    this.wslMaterializations.set(surface.key, {
      accountId,
      configDir: paths.configDir,
      linuxConfigDir: paths.linuxConfigDir
    })
  }

  // Why: re-auth/add-account write fresh managed tokens; skip the next read-back so stale runtime tokens can't overwrite them.
  clearLastWrittenCredentialsJson(
    accountId = this.store.getSettings().activeClaudeManagedAccountId
  ): void {
    const settings = this.store.getSettings()
    const account = this.getActiveAccount(settings.claudeManagedAccounts, accountId)
    // Why: WSL selections never touch activeClaudeManagedAccountId, so the surface has to come from the account itself.
    const target = this.getSelectionTargetForAccount(account)
    const surface = this.resolveSurfaceForTarget(normalizeClaudeAccountSelectionTarget(target))
    if (!surface) {
      return
    }
    if (accountId === getSelectedClaudeAccountIdForTarget(settings, target)) {
      surface.state.lastWrittenCredentialsJson = null
    }
    surface.state.skipNextReadBackForAccountId = accountId
  }

  private getSelectionTargetForAccount(
    account: ClaudeManagedAccount | null
  ): ClaudeAccountSelectionTarget {
    return account ? getClaudeSelectionTargetForAccount(account) : { runtime: 'host' }
  }

  // Why: the macOS Keychain only backs the host runtime; a WSL distro's auth is purely file-based.
  private isKeychainSurface(): boolean {
    return process.platform === 'darwin' && this.surface.key === HOST_AUTH_SURFACE_KEY
  }

  private async readBackRefreshedTokens(
    baselineCredentialsJson: string,
    options: { updateLastWrittenCredentialsJson: boolean }
  ): Promise<ClaudeReadBackResult> {
    try {
      const candidates =
        await this.readRuntimeCredentialCandidatesForReadBack(baselineCredentialsJson)
      if (candidates.length === 0) {
        return { status: 'unchanged' }
      }
      const changedCandidates =
        this.surface.state.lastWrittenCredentialsJson === null
          ? candidates
          : candidates.filter(
              (candidate) =>
                candidate.credentialsJson !== this.surface.state.lastWrittenCredentialsJson
            )
      if (changedCandidates.length === 0) {
        return { status: 'unchanged' }
      }

      const acceptedCandidates: {
        credentialsJson: string
        match: Extract<ClaudeReadBackMatch, { kind: 'matched' }>
      }[] = []
      const ambiguousCandidates: string[] = []
      let sawAmbiguousCandidate = false
      let sawValidChangedCandidate = false
      for (const runtimeContents of changedCandidates) {
        if (!this.isValidCredentialsJsonObject(runtimeContents.credentialsJson)) {
          continue
        }
        sawValidChangedCandidate = true
        const match = await this.findManagedAccountForRuntimeCredentials(
          runtimeContents.credentialsJson,
          runtimeContents.runtimeOauthAccount
        )
        if (match.kind === 'ambiguous') {
          sawAmbiguousCandidate = true
          ambiguousCandidates.push(runtimeContents.credentialsJson)
          continue
        }
        if (match.kind !== 'matched') {
          continue
        }
        // Why: on cold start we can't tell a fresh CLI refresh from stale runtime creds; adopt only when expiry or a rotated refresh token proves runtime is newer than managed.
        if (this.surface.state.lastWrittenCredentialsJson === null) {
          const fresher = this.runtimeCredentialsAreFresher(
            runtimeContents.credentialsJson,
            match.managedCredentialsJson
          )
          const refreshTokenRotated =
            this.compareRefreshTokens(
              runtimeContents.credentialsJson,
              match.managedCredentialsJson
            ) === 'different'
          const older = this.runtimeCredentialsAreOlder(
            runtimeContents.credentialsJson,
            match.managedCredentialsJson
          )
          if (!fresher && !(refreshTokenRotated && !older)) {
            continue
          }
        } else if (
          this.runtimeCredentialsAreOlder(
            runtimeContents.credentialsJson,
            match.managedCredentialsJson
          )
        ) {
          continue
        }
        acceptedCandidates.push({
          credentialsJson: runtimeContents.credentialsJson,
          match
        })
      }
      if (acceptedCandidates.length === 0) {
        if (sawAmbiguousCandidate) {
          console.warn('[claude-runtime-auth] Refusing ambiguous Claude auth read-back')
        }
        return {
          status: 'rejected',
          runtimeCredentialsChanged: true,
          hasValidChangedRuntimeCredentials: sawValidChangedCandidate,
          runtimeCredentialsJson:
            ambiguousCandidates.length === 1 ? ambiguousCandidates[0] : undefined
        }
      }
      const { credentialsJson: runtimeContents, match } =
        this.chooseFreshestReadBackCandidate(acceptedCandidates)

      await this.writeManagedCredentials(match.account, runtimeContents)
      if (options.updateLastWrittenCredentialsJson) {
        this.writeRuntimeCredentials(runtimeContents)
        this.surface.state.lastWrittenCredentialsJson = runtimeContents
        if (this.isKeychainSurface()) {
          const paths = this.surface.getPaths()
          await writeActiveClaudeKeychainCredentialsForRuntime(runtimeContents, paths.configDir)
        }
      }
      return { status: 'persisted' }
    } catch (error) {
      // Why: read-back is best-effort; a transient fs error must not block forward sync (worst case: one more stale-token cycle).
      console.warn('[claude-runtime-auth] Failed to read back refreshed tokens:', error)
      return {
        status: 'rejected',
        runtimeCredentialsChanged:
          this.runtimeCredentialsChangedSinceLastWrite(baselineCredentialsJson),
        // Why: an fs error hides whether a live session's refresh is present, so err toward preserving runtime state.
        hasValidChangedRuntimeCredentials: true
      }
    }
  }

  private async readRuntimeCredentialCandidatesForReadBack(
    baselineCredentialsJson: string
  ): Promise<ClaudeRuntimeCredentialCandidate[]> {
    const paths = this.surface.getPaths()
    // Why: an unconfirmed read yields no candidate, so a spurious 9P ENOENT can only cost one
    // read-back cycle — it can never invent an empty runtime blob to adopt.
    const fileCredentials = this.readRuntimeCredentialsFile()
    const runtimeOauthAccount = await this.readRuntimeOauthAccount()
    const candidates: ClaudeRuntimeCredentialCandidate[] = []
    const pushCandidate = (credentialsJson: string | null): void => {
      if (
        credentialsJson &&
        !candidates.some((candidate) => candidate.credentialsJson === credentialsJson)
      ) {
        candidates.push({ credentialsJson, runtimeOauthAccount })
      }
    }
    if (this.isKeychainSurface()) {
      const scopedKeychainCredentials = await this.readActiveClaudeKeychainCredentialsBestEffort(
        paths.configDir
      )
      const legacyKeychainCredentials = await this.readActiveClaudeKeychainCredentialsBestEffort()
      if (this.surface.state.lastWrittenCredentialsJson === null) {
        pushCandidate(scopedKeychainCredentials)
        pushCandidate(legacyKeychainCredentials)
        pushCandidate(fileCredentials)
        return candidates.filter(
          (candidate) => candidate.credentialsJson !== baselineCredentialsJson
        )
      }
      pushCandidate(scopedKeychainCredentials)
      pushCandidate(legacyKeychainCredentials)
    }
    pushCandidate(fileCredentials)
    return candidates
  }

  private getPreparation(target?: ClaudeAccountSelectionTarget): ClaudeRuntimeAuthPreparation {
    const settings = this.store.getSettings()
    const paths = this.pathResolver.getRuntimePaths()
    const normalizedTarget = normalizeClaudeAccountSelectionTarget(
      this.resolveWslDefaultTarget(target ?? this.getDefaultAccountSelectionTarget(settings))
    )
    const activeAccountId = getSelectedClaudeAccountIdForTarget(settings, normalizedTarget)
    const activeAccount = this.getActiveAccount(settings.claudeManagedAccounts, activeAccountId)
    if (
      normalizedTarget.runtime === 'wsl' &&
      activeAccount?.managedAuthRuntime === 'wsl' &&
      activeAccount.wslLinuxAuthPath
    ) {
      const materialized = activeAccount.wslDistro
        ? this.wslMaterializations.get(wslAuthSurfaceKey(activeAccount.wslDistro))
        : undefined
      // Why: the account's auth slot holds credentials only, so it may only stand in for the whole
      // config dir when the distro's own profile could not be written to.
      const distroProfile = materialized?.accountId === activeAccount.id ? materialized : null
      return {
        configDir: distroProfile ? distroProfile.configDir : activeAccount.managedAuthPath,
        runtime: 'wsl',
        wslDistro: activeAccount.wslDistro ?? null,
        wslLinuxConfigDir: distroProfile
          ? distroProfile.linuxConfigDir
          : activeAccount.wslLinuxAuthPath,
        envPatch: distroProfile ? {} : { CLAUDE_CONFIG_DIR: activeAccount.wslLinuxAuthPath },
        stripAuthEnv: true,
        provenance: `managed:${activeAccount.id}:wsl:${activeAccount.wslDistro ?? ''}`
      }
    }
    if (normalizedTarget.runtime === 'wsl') {
      const distro = normalizedTarget.wslDistro ?? getDefaultWslDistro()
      const wslPaths = distro ? resolveWslProfilePaths(distro) : null
      if (distro && wslPaths) {
        return {
          configDir: wslPaths.configDir,
          runtime: 'wsl',
          wslDistro: distro,
          wslLinuxConfigDir: wslPaths.linuxConfigDir,
          envPatch: {},
          stripAuthEnv: true,
          provenance: `wsl:${distro}:system`
        }
      }
      return {
        configDir: paths.configDir,
        runtime: 'wsl',
        wslDistro: normalizedTarget.wslDistro,
        wslLinuxConfigDir: null,
        envPatch: {},
        stripAuthEnv: true,
        provenance: `wsl:${normalizedTarget.wslDistro ?? '__default__'}:system`
      }
    }
    return {
      configDir: paths.configDir,
      runtime: 'host',
      wslDistro: null,
      wslLinuxConfigDir: null,
      envPatch: paths.envPatch,
      stripAuthEnv: Boolean(activeAccountId && activeAccount?.managedAuthRuntime !== 'wsl'),
      managedRefreshDeferredByLivePty: Boolean(
        activeAccountId &&
        activeAccount?.managedAuthRuntime !== 'wsl' &&
        this.managedRefreshDeferredByLivePtyAccountId === activeAccountId
      ),
      provenance:
        activeAccountId && activeAccount?.managedAuthRuntime !== 'wsl'
          ? `managed:${activeAccountId}`
          : 'system'
    }
  }

  private getActiveAccount(
    accounts: ClaudeManagedAccount[],
    activeAccountId: string | null
  ): ClaudeManagedAccount | null {
    if (!activeAccountId) {
      return null
    }
    return accounts.find((account) => account.id === activeAccountId) ?? null
  }

  private getDefaultAccountSelectionTarget(
    settings = this.store.getSettings()
  ): ClaudeAccountSelectionTarget {
    // Why: Windows auth follows the resolved account runtime; stale cross-platform WSL pins must stay local-host.
    const resolved = resolveLocalAccountRuntimeTarget(settings)
    if (process.platform === 'win32' && resolved.runtime === 'wsl') {
      return { runtime: 'wsl', wslDistro: resolved.wslDistro }
    }
    return { runtime: 'host' }
  }

  private resolveWslDefaultTarget(
    target?: ClaudeAccountSelectionTarget
  ): ClaudeAccountSelectionTarget {
    if (target?.runtime !== 'wsl' || target.wslDistro?.trim()) {
      return target ?? { runtime: 'host' }
    }
    const defaultDistro = getDefaultWslDistro()
    return defaultDistro ? { runtime: 'wsl', wslDistro: defaultDistro } : target
  }

  private async findManagedAccountForRuntimeCredentials(
    runtimeCredentialsJson: string,
    runtimeOauthAccount: unknown
  ): Promise<ClaudeReadBackMatch> {
    const matches: { account: ClaudeManagedAccount; managedCredentialsJson: string }[] = []
    let unverifiableCount = 0
    for (const account of this.store.getSettings().claudeManagedAccounts) {
      const managedCredentialsJson = await this.readManagedCredentials(account)
      if (!managedCredentialsJson) {
        continue
      }
      const match = this.runtimeCredentialsMatchAccount(
        runtimeCredentialsJson,
        runtimeOauthAccount,
        account,
        managedCredentialsJson,
        this.readManagedOauthAccount(account)
      )
      if (match === 'match') {
        matches.push({ account, managedCredentialsJson })
      } else if (match === 'unverifiable') {
        unverifiableCount += 1
      }
    }

    if (matches.length === 1 && unverifiableCount === 0) {
      return { kind: 'matched', ...matches[0] }
    }
    return {
      kind: matches.length === 0 && unverifiableCount === 0 ? 'none' : 'ambiguous'
    }
  }

  private runtimeCredentialsMatchAccount(
    runtimeCredentialsJson: string,
    runtimeOauthAccount: unknown,
    account: ClaudeManagedAccount,
    managedCredentialsJson: string,
    managedOauthAccount: unknown
  ): 'match' | 'mismatch' | 'unverifiable' {
    const identity = this.readIdentityFromCredentials(runtimeCredentialsJson)
    if (!identity) {
      return 'mismatch'
    }
    const managedIdentity = this.readIdentityFromCredentials(managedCredentialsJson)
    const managedOauthIdentity = this.readIdentityFromOauthAccount(managedOauthAccount)
    const runtimeOauthIdentity = this.readIdentityFromOauthAccount(runtimeOauthAccount)
    const credentialOauthConflict =
      (identity.accountUuid &&
        runtimeOauthIdentity.accountUuid &&
        identity.accountUuid !== runtimeOauthIdentity.accountUuid) ||
      (identity.email &&
        runtimeOauthIdentity.email &&
        identity.email !== runtimeOauthIdentity.email) ||
      (identity.organizationUuid &&
        runtimeOauthIdentity.organizationUuid &&
        identity.organizationUuid !== runtimeOauthIdentity.organizationUuid)
    if (credentialOauthConflict) {
      return 'mismatch'
    }

    // Why: mirrors the Codex runtime-home guard; don't persist shared runtime creds into the managed account if another login rewrote them.
    const selectedOrganizationUuid = this.normalizeField(
      account.organizationUuid ??
        managedIdentity?.organizationUuid ??
        managedOauthIdentity.organizationUuid
    )
    const oauthAccountMatches =
      Boolean(managedOauthIdentity.accountUuid) &&
      managedOauthIdentity.accountUuid === runtimeOauthIdentity.accountUuid &&
      Boolean(runtimeOauthIdentity.email || runtimeOauthIdentity.organizationUuid)
    const runtimeEmail = identity.email ?? runtimeOauthIdentity.email
    const runtimeOrganizationUuid =
      identity.organizationUuid ?? runtimeOauthIdentity.organizationUuid
    const refreshTokenComparison = this.compareRefreshTokens(
      runtimeCredentialsJson,
      managedCredentialsJson
    )
    if (!runtimeEmail) {
      if (refreshTokenComparison === 'same') {
        return 'match'
      }
      if (identity.organizationUuid) {
        if (selectedOrganizationUuid && selectedOrganizationUuid !== identity.organizationUuid) {
          return 'mismatch'
        }
        return 'unverifiable'
      }
      if (oauthAccountMatches) {
        return 'match'
      }
      if (!runtimeOrganizationUuid && refreshTokenComparison === 'different') {
        return 'mismatch'
      }
      return 'unverifiable'
    }
    if (account.email && this.normalizeField(account.email) !== runtimeEmail) {
      return 'mismatch'
    }
    if (selectedOrganizationUuid && !runtimeOrganizationUuid) {
      return refreshTokenComparison === 'same' || oauthAccountMatches ? 'match' : 'unverifiable'
    }
    if (
      selectedOrganizationUuid &&
      runtimeOrganizationUuid &&
      selectedOrganizationUuid !== runtimeOrganizationUuid
    ) {
      return 'mismatch'
    }
    if (!selectedOrganizationUuid && runtimeOrganizationUuid) {
      return refreshTokenComparison === 'same' ? 'match' : 'unverifiable'
    }

    return 'match'
  }

  private async liveRuntimeCredentialsCanUpdateActiveAccount(
    runtimeCredentialsJson: string,
    account: ClaudeManagedAccount,
    managedCredentialsJson: string,
    managedOauthAccount: unknown
  ): Promise<boolean> {
    const runtimeOauthAccount = await this.readRuntimeOauthAccount()
    const match = this.runtimeCredentialsMatchAccount(
      runtimeCredentialsJson,
      runtimeOauthAccount,
      account,
      managedCredentialsJson,
      managedOauthAccount
    )
    if (match === 'match') {
      return true
    }
    const identity = this.readIdentityFromCredentials(runtimeCredentialsJson)
    const managedIdentity = this.readIdentityFromCredentials(managedCredentialsJson)
    const managedOauthIdentity = this.readIdentityFromOauthAccount(managedOauthAccount)
    const runtimeOauthIdentity = this.readIdentityFromOauthAccount(runtimeOauthAccount)
    const selectedOrganizationUuid = this.normalizeField(
      account.organizationUuid ??
        managedIdentity?.organizationUuid ??
        managedOauthIdentity.organizationUuid
    )
    return (
      match === 'unverifiable' &&
      Boolean(selectedOrganizationUuid) &&
      (identity?.organizationUuid ?? runtimeOauthIdentity.organizationUuid) ===
        selectedOrganizationUuid
    )
  }

  private readIdentityFromCredentials(credentialsJson: string): ClaudeAuthIdentity | null {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(credentialsJson) as Record<string, unknown>
    } catch {
      return null
    }
    const oauth = this.asRecord(parsed.claudeAiOauth)
    return {
      accountUuid: this.normalizeField(
        this.readString(oauth, 'accountUuid') ?? this.readString(oauth, 'accountId')
      ),
      email: this.normalizeField(this.readString(oauth, 'email')),
      organizationUuid: this.normalizeField(
        this.readString(oauth, 'organizationUuid') ?? this.readString(oauth, 'organizationId')
      )
    }
  }

  private isValidCredentialsJsonObject(credentialsJson: string): boolean {
    try {
      const parsed = this.asRecord(JSON.parse(credentialsJson))
      const oauth = this.asRecord(parsed?.claudeAiOauth)
      return this.normalizeField(this.readString(oauth, 'accessToken')) !== null
    } catch {
      return false
    }
  }

  private runtimeCredentialsAreFresher(
    runtimeCredentialsJson: string,
    managedCredentialsJson: string
  ): boolean {
    const runtimeFreshness = this.readFreshnessFromCredentials(runtimeCredentialsJson)
    const managedFreshness = this.readFreshnessFromCredentials(managedCredentialsJson)
    return (
      runtimeFreshness !== null && managedFreshness !== null && runtimeFreshness > managedFreshness
    )
  }

  private runtimeCredentialsAreOlder(
    runtimeCredentialsJson: string,
    managedCredentialsJson: string
  ): boolean {
    const runtimeFreshness = this.readFreshnessFromCredentials(runtimeCredentialsJson)
    const managedFreshness = this.readFreshnessFromCredentials(managedCredentialsJson)
    return (
      runtimeFreshness !== null && managedFreshness !== null && runtimeFreshness < managedFreshness
    )
  }

  private chooseFreshestReadBackCandidate(
    candidates: {
      credentialsJson: string
      match: Extract<ClaudeReadBackMatch, { kind: 'matched' }>
    }[]
  ): {
    credentialsJson: string
    match: Extract<ClaudeReadBackMatch, { kind: 'matched' }>
  } {
    return candidates.reduce((freshest, candidate) => {
      const candidateFreshness = this.readFreshnessFromCredentials(candidate.credentialsJson)
      const freshestFreshness = this.readFreshnessFromCredentials(freshest.credentialsJson)
      if (
        candidateFreshness !== null &&
        (freshestFreshness === null || candidateFreshness > freshestFreshness)
      ) {
        return candidate
      }
      return freshest
    })
  }

  private readFreshnessFromCredentials(credentialsJson: string): number | null {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(credentialsJson) as Record<string, unknown>
    } catch {
      return null
    }
    const oauth = this.asRecord(parsed.claudeAiOauth)
    return (
      this.readNumber(oauth, 'expiresAt') ??
      this.readNumber(oauth, 'expires_at') ??
      this.readNumber(oauth, 'expiry') ??
      this.readNumber(oauth, 'expires')
    )
  }

  private compareRefreshTokens(
    runtimeCredentialsJson: string,
    managedCredentialsJson: string
  ): ClaudeRefreshTokenComparison {
    const runtimeRefreshToken = this.readRefreshTokenFromCredentials(runtimeCredentialsJson)
    const managedRefreshToken = this.readRefreshTokenFromCredentials(managedCredentialsJson)
    if (!runtimeRefreshToken || !managedRefreshToken) {
      return 'missing'
    }
    return runtimeRefreshToken === managedRefreshToken ? 'same' : 'different'
  }

  private readRefreshTokenFromCredentials(credentialsJson: string): string | null {
    try {
      const parsed = JSON.parse(credentialsJson) as Record<string, unknown>
      const oauth = this.asRecord(parsed.claudeAiOauth)
      return this.normalizeField(this.readString(oauth, 'refreshToken'))
    } catch {
      return null
    }
  }

  private readIdentityFromOauthAccount(oauthAccount: unknown): ClaudeAuthIdentity {
    const oauth = this.asRecord(oauthAccount)
    return {
      accountUuid: this.normalizeField(
        this.readString(oauth, 'accountUuid') ?? this.readString(oauth, 'accountId')
      ),
      email: this.normalizeField(
        this.readString(oauth, 'emailAddress') ?? this.readString(oauth, 'email')
      ),
      organizationUuid: this.normalizeField(
        this.readString(oauth, 'organizationUuid') ?? this.readString(oauth, 'organizationId')
      )
    }
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null
    }
    return value as Record<string, unknown>
  }

  private readString(value: Record<string, unknown> | null, key: string): string | null {
    const candidate = value?.[key]
    return typeof candidate === 'string' ? candidate : null
  }

  private readNumber(value: Record<string, unknown> | null, key: string): number | null {
    const candidate = value?.[key]
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate
    }
    if (typeof candidate === 'string') {
      const parsed = Number(candidate)
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

  private async readManagedCredentials(account: ClaudeManagedAccount): Promise<string | null> {
    const managedAuthPath = this.getOwnedManagedAuthPath(account)
    if (!managedAuthPath) {
      return null
    }
    if (process.platform === 'darwin') {
      return readManagedClaudeKeychainCredentials(account.id)
    }
    return readClaudeManagedAuthFile(managedAuthPath, '.credentials.json')
  }

  private async writeManagedCredentials(
    account: ClaudeManagedAccount,
    credentialsJson: string
  ): Promise<void> {
    const managedAuthPath = this.getOwnedManagedAuthPath(account)
    if (!managedAuthPath) {
      throw new Error('Managed Claude auth storage is not owned by Orca.')
    }
    if (process.platform === 'darwin') {
      await writeManagedClaudeKeychainCredentials(account.id, credentialsJson)
      return
    }
    writeClaudeManagedAuthFile(managedAuthPath, '.credentials.json', credentialsJson)
  }

  /**
   * Proactively refresh an account's OAuth token and persist the rotation to
   * managed storage. Returns the refreshed credentials JSON, or null when no
   * refresh happened (token valid, no refresh token, or network failure).
   *
   * Caller guarantees this account isn't the live/active one and runs inside the
   * serialized mutation queue, so the single-use refresh token can't rotate concurrently.
   */
  private async refreshManagedAccountTokenIfNeeded(
    account: ClaudeManagedAccount,
    credentialsJson: string
  ): Promise<string | null> {
    if (!isOauthTokenExpiring(credentialsJson)) {
      return null
    }
    const refreshed = await refreshClaudeOauthCredentials(credentialsJson)
    if (!refreshed || !this.isValidCredentialsJsonObject(refreshed)) {
      return null
    }
    try {
      await this.writeManagedCredentials(account, refreshed)
    } catch (error) {
      console.warn('[claude-runtime-auth] Failed to persist refreshed Claude token:', error)
      return null
    }
    return refreshed
  }

  private readManagedOauthAccount(account: ClaudeManagedAccount): unknown {
    const managedAuthPath = this.getOwnedManagedAuthPath(account)
    if (!managedAuthPath) {
      return null
    }
    try {
      const contents = readClaudeManagedAuthFile(managedAuthPath, 'oauth-account.json')
      return contents ? (JSON.parse(contents) as unknown) : null
    } catch {
      return null
    }
  }

  private getOwnedManagedAuthPath(account: ClaudeManagedAccount): string | null {
    const cached = this.ownedManagedAuthPaths.get(account.id)
    if (cached !== undefined) {
      return cached
    }
    const resolved = this.resolveOwnedManagedAuthPath(account)
    this.ownedManagedAuthPaths.set(account.id, resolved)
    return resolved
  }

  private resolveOwnedManagedAuthPath(account: ClaudeManagedAccount): string | null {
    const wslInfo = parseWslUncPath(account.managedAuthPath)
    if (wslInfo) {
      if (
        !wslInfo.linuxPath.includes('/.local/share/orca/claude-accounts/') ||
        !wslInfo.linuxPath.endsWith('/auth')
      ) {
        return null
      }
      if (process.platform === 'win32') {
        try {
          const canonicalLinuxPath = execFileSync(
            'wsl.exe',
            [
              '-d',
              wslInfo.distro,
              '--',
              'bash',
              '-lc',
              buildEncodedWslBashCommand(
                [
                  'set -euo pipefail',
                  `candidate=${shellQuote(wslInfo.linuxPath)}`,
                  'managed_root="${HOME%/}/.local/share/orca/claude-accounts"',
                  'candidate_real=$(readlink -f -- "$candidate")',
                  'managed_root_real=$(readlink -f -- "$managed_root")',
                  'test -f "$candidate_real/.orca-managed-claude-auth"',
                  `test "$(cat "$candidate_real/.orca-managed-claude-auth")" = ${shellQuote(account.id)}`,
                  'case "$candidate_real" in "$managed_root_real"/*/auth) printf "%s\\n" "$candidate_real" ;; *) exit 35 ;; esac'
                ].join('\n')
              )
            ],
            { encoding: 'utf-8', timeout: 5000 }
          ).trim()
          return canonicalLinuxPath ? toWindowsWslPath(canonicalLinuxPath, wslInfo.distro) : null
        } catch {
          return null
        }
      }
      return existsSync(account.managedAuthPath) ? account.managedAuthPath : null
    }
    return resolveOwnedClaudeManagedAuthPath(account.id, account.managedAuthPath, {
      adoptLegacyMarker: true
    })
  }

  /**
   * Capture the login Orca is about to displace. `unconfirmed` means the surface could not be read
   * through the 9P share: there is then no recoverable copy, so the caller must not write.
   */
  private async captureSystemDefaultSnapshotForManagedEntry(
    managedCredentialsJson: string
  ): Promise<'captured' | 'unconfirmed'> {
    const runtimeCredentials = this.readSurfaceCredentials()
    if (runtimeCredentials.status !== 'read') {
      return 'unconfirmed'
    }
    const snapshotPath = this.getSystemDefaultSnapshotPath()
    const existingSnapshot = this.readSystemDefaultSnapshot(snapshotPath)
    if (runtimeCredentials.contents !== managedCredentialsJson) {
      return this.captureSystemDefaultSnapshot({
        force: true,
        credentialsJson: runtimeCredentials.contents,
        previousSnapshot: existingSnapshot,
        managedCredentialsJson
      })
    }
    if (existingSnapshot) {
      return this.captureSystemDefaultSnapshot({
        force: true,
        credentialsJson: existingSnapshot.credentialsJson,
        previousSnapshot: existingSnapshot,
        managedCredentialsJson
      })
    }
    return this.captureSystemDefaultSnapshot({
      force: false,
      credentialsJson: runtimeCredentials.contents
    })
  }

  private async captureSystemDefaultSnapshot(options: {
    force: boolean
    credentialsJson: string | null
    previousSnapshot?: ClaudeSystemDefaultSnapshot | null
    managedCredentialsJson?: string
  }): Promise<'captured' | 'unconfirmed'> {
    const snapshotPath = this.getSystemDefaultSnapshotPath()
    if (!options.force && existsSync(snapshotPath)) {
      return 'captured'
    }

    const paths = this.surface.getPaths()
    const credentialsJson = options.credentialsJson
    const configOauthAccount = await this.readRuntimeOauthAccount()
    if (configOauthAccount === RUNTIME_OAUTH_ACCOUNT_UNREADABLE) {
      // Why: recording an unread `.claude.json` as "no oauthAccount" would make the restore strip the
      // user's own identity out of it.
      return 'unconfirmed'
    }
    const keychainCredentialsJson = await this.readAggregateClaudeKeychainCredentialsBestEffort(
      paths.configDir
    )
    const scopedKeychainCredentials = this.isKeychainSurface()
      ? await this.readActiveClaudeKeychainCredentialsForSnapshot(paths.configDir)
      : ({ status: 'captured', credentialsJson: null } as const)
    const legacyKeychainCredentialsJson = this.isKeychainSurface()
      ? await this.readActiveClaudeKeychainCredentialsForSnapshot()
      : ({ status: 'captured', credentialsJson: null } as const)
    if (
      scopedKeychainCredentials.status === 'failed' ||
      legacyKeychainCredentialsJson.status === 'failed'
    ) {
      throw new Error('Cannot capture current Claude Keychain credentials')
    }
    const scopedKeychainCredentialsJson =
      scopedKeychainCredentials.status === 'captured'
        ? this.snapshotKeychainCredentials(
            scopedKeychainCredentials.credentialsJson,
            options.previousSnapshot,
            'scoped',
            options.managedCredentialsJson
          )
        : undefined
    const legacyKeychainSnapshotJson =
      legacyKeychainCredentialsJson.status === 'captured'
        ? this.snapshotKeychainCredentials(
            legacyKeychainCredentialsJson.credentialsJson,
            options.previousSnapshot,
            'legacy',
            options.managedCredentialsJson
          )
        : undefined
    const snapshot: ClaudeSystemDefaultSnapshot = {
      credentialsJson,
      configOauthAccount:
        configOauthAccount === RUNTIME_OAUTH_ACCOUNT_PARSE_ERROR ? null : configOauthAccount,
      keychainCredentialsJson,
      scopedKeychainCredentialsJson,
      legacyKeychainCredentialsJson: legacyKeychainSnapshotJson,
      scopedKeychainCredentialsCaptured: scopedKeychainCredentials.status === 'captured',
      legacyKeychainCredentialsCaptured: legacyKeychainCredentialsJson.status === 'captured',
      // Why: capture only runs on entry, when Orca does not yet own the surface; the materialization
      // that follows records the owner.
      materializedAccountId: null,
      capturedAt: Date.now()
    }
    this.writeJson(snapshotPath, snapshot)
    return 'captured'
  }

  private async restoreSystemDefaultSnapshot(
    ownedCredentialsJson?: string | null,
    ownedOauthAccount?: unknown
  ): Promise<void> {
    const snapshotPath = this.getSystemDefaultSnapshotPath()
    const paths = this.surface.getPaths()
    const previouslyWrittenCredentialsJson =
      this.surface.state.lastWrittenCredentialsJson ?? ownedCredentialsJson ?? null
    const snapshot = this.readSystemDefaultSnapshot(snapshotPath)

    const fileCredentialsOwned = this.hasUnchangedRuntimeCredentials(
      previouslyWrittenCredentialsJson
    )
    let hasCredentialSurfaceOwnership = fileCredentialsOwned
    // Why: prove ownership before mutating anything, and restore OAuth first so a failure leaves the credential proof intact for retry.
    this.surface.state.lastWrittenCredentialsJson = previouslyWrittenCredentialsJson
    let scopedSnapshot: ClaudeKeychainSnapshotValue | null = null
    let legacySnapshot: ClaudeKeychainSnapshotValue | null = null
    let scopedKeychainOwned = false
    let legacyKeychainOwned = false
    if (this.isKeychainSurface()) {
      scopedSnapshot = this.readKeychainSnapshotValue(snapshot, 'scoped')
      legacySnapshot = this.readKeychainSnapshotValue(snapshot, 'legacy')
      scopedKeychainOwned = await this.hasUnchangedActiveClaudeKeychainCredentials(
        scopedSnapshot,
        previouslyWrittenCredentialsJson,
        paths.configDir
      )
      legacyKeychainOwned = await this.hasUnchangedActiveClaudeKeychainCredentials(
        legacySnapshot,
        previouslyWrittenCredentialsJson
      )
      hasCredentialSurfaceOwnership =
        fileCredentialsOwned || scopedKeychainOwned || legacyKeychainOwned
    }
    await this.restoreRuntimeOauthAccountIfOwned(
      snapshot?.configOauthAccount ?? null,
      this.getOwnedRuntimeOauthBaseline(ownedOauthAccount, hasCredentialSurfaceOwnership),
      { allowCredentialSurfaceOwnership: hasCredentialSurfaceOwnership }
    )
    if (fileCredentialsOwned) {
      this.restoreRuntimeCredentials(snapshot?.credentialsJson ?? null)
    }
    if (this.isKeychainSurface()) {
      if (scopedSnapshot?.status === 'captured' && scopedKeychainOwned) {
        await this.restoreActiveClaudeKeychainCredentials(
          scopedSnapshot.credentialsJson,
          paths.configDir
        )
      }
      if (legacySnapshot?.status === 'captured' && legacyKeychainOwned) {
        await this.restoreActiveClaudeKeychainCredentials(legacySnapshot.credentialsJson)
      }
    }
    this.surface.state.lastWrittenCredentialsJson = null
    this.surface.state.lastWrittenOauthAccount = null
    this.surface.state.hasLastWrittenOauthAccount = false
    this.surface.state.hasMaterializedRuntimeAuth = false
    // Why: the profile has been handed back, so the persisted ownership claim must go with it.
    this.persistSurfaceMaterializedAccountId(null)
  }

  private getOwnedRuntimeOauthBaseline(
    ownedOauthAccount: unknown,
    hasCredentialSurfaceOwnership: boolean
  ): unknown {
    if (this.surface.state.hasLastWrittenOauthAccount) {
      return this.surface.state.lastWrittenOauthAccount
    }
    // Why: managed metadata hints identity but isn't proof Orca wrote .claude.json; use only after a credential surface proves ownership.
    if (hasCredentialSurfaceOwnership && ownedOauthAccount !== undefined) {
      return ownedOauthAccount
    }
    return null
  }

  private readSystemDefaultSnapshot(snapshotPath: string): ClaudeSystemDefaultSnapshot | null {
    if (!existsSync(snapshotPath)) {
      return null
    }
    try {
      const parsed = JSON.parse(readFileSync(snapshotPath, 'utf-8')) as unknown
      if (this.isSystemDefaultSnapshot(parsed)) {
        return parsed
      }
      throw new Error('Invalid Claude system-default auth snapshot shape')
    } catch (error) {
      console.warn('[claude-runtime-auth] Ignoring invalid system-default auth snapshot:', error)
      rmSync(snapshotPath, { force: true })
      return null
    }
  }

  private async clearRuntimeAuthForAccount(
    account: ClaudeManagedAccount,
    managedOauthAccount: unknown
  ): Promise<void> {
    const paths = this.surface.getPaths()
    const fileCredentialsOwned = this.runtimeCredentialsBelongToAccount(
      this.readRuntimeCredentialsFile(),
      account,
      managedOauthAccount
    )
    let scopedKeychainOwned = false
    let legacyKeychainOwned = false
    if (this.isKeychainSurface()) {
      scopedKeychainOwned = await this.hasActiveKeychainCredentialsForAccount(
        account,
        managedOauthAccount,
        paths.configDir
      )
      legacyKeychainOwned = await this.hasActiveKeychainCredentialsForAccount(
        account,
        managedOauthAccount
      )
    }
    const hasCredentialSurfaceOwnership =
      fileCredentialsOwned || scopedKeychainOwned || legacyKeychainOwned
    await this.restoreRuntimeOauthAccountIfOwned(
      null,
      this.getOwnedRuntimeOauthBaseline(managedOauthAccount, hasCredentialSurfaceOwnership),
      {
        allowCredentialSurfaceOwnership: hasCredentialSurfaceOwnership
      }
    )
    if (fileCredentialsOwned) {
      rmSync(paths.credentialsPath, { force: true })
    }
    if (this.isKeychainSurface()) {
      if (scopedKeychainOwned) {
        await deleteActiveClaudeKeychainCredentialsStrict(paths.configDir)
      }
      if (legacyKeychainOwned) {
        await deleteActiveClaudeKeychainCredentialsStrict()
      }
    }
  }

  private async restoreSystemDefaultSnapshotForMissingManagedCredentials(
    account: ClaudeManagedAccount,
    managedOauthAccount: unknown
  ): Promise<void> {
    const snapshot = this.readSystemDefaultSnapshot(this.getSystemDefaultSnapshotPath())
    if (!snapshot) {
      await this.clearRuntimeAuthForAccount(account, managedOauthAccount)
      this.clearLastWrittenRuntimeState()
      return
    }
    const paths = this.surface.getPaths()
    const fileCredentialsOwned = this.runtimeCredentialsBelongToAccount(
      this.readRuntimeCredentialsFile(),
      account,
      managedOauthAccount
    )
    let scopedSnapshot: ClaudeKeychainSnapshotValue | null = null
    let legacySnapshot: ClaudeKeychainSnapshotValue | null = null
    let scopedKeychainOwned = false
    let legacyKeychainOwned = false
    if (this.isKeychainSurface()) {
      scopedSnapshot = this.readKeychainSnapshotValue(snapshot, 'scoped')
      legacySnapshot = this.readKeychainSnapshotValue(snapshot, 'legacy')
      scopedKeychainOwned = await this.hasActiveKeychainCredentialsForAccount(
        account,
        managedOauthAccount,
        paths.configDir
      )
      legacyKeychainOwned = await this.hasActiveKeychainCredentialsForAccount(
        account,
        managedOauthAccount
      )
    }
    const hasCredentialSurfaceOwnership =
      fileCredentialsOwned || scopedKeychainOwned || legacyKeychainOwned
    await this.restoreRuntimeOauthAccountIfOwned(
      snapshot.configOauthAccount,
      this.getOwnedRuntimeOauthBaseline(managedOauthAccount, hasCredentialSurfaceOwnership),
      {
        allowCredentialSurfaceOwnership: hasCredentialSurfaceOwnership
      }
    )
    if (fileCredentialsOwned) {
      this.restoreRuntimeCredentials(snapshot.credentialsJson)
    }
    if (this.isKeychainSurface()) {
      if (scopedSnapshot?.status === 'captured' && scopedKeychainOwned) {
        await this.restoreActiveClaudeKeychainCredentials(
          scopedSnapshot.credentialsJson,
          paths.configDir
        )
      }
      if (legacySnapshot?.status === 'captured' && legacyKeychainOwned) {
        await this.restoreActiveClaudeKeychainCredentials(legacySnapshot.credentialsJson)
      }
    }
    this.clearLastWrittenRuntimeState()
  }

  /**
   * The only sanctioned way to read a file off an auth surface.
   *
   * Why: Win32 `existsSync` reports spurious ENOENT over the WSL 9P share, so on a distro surface
   * only the distro's own `test -f` may be believed when the file looks absent. Reading an ENOENT
   * that isn't real as "no credentials" is what lets a snapshot record the user's only login as null
   * and a later restore delete it.
   */
  private readSurfaceFile(targetPath: string, surfaceKey: string): ClaudeSurfaceFileRead {
    if (existsSync(targetPath)) {
      return { status: 'read', contents: readFileSync(targetPath, 'utf-8') }
    }
    if (surfaceKey === HOST_AUTH_SURFACE_KEY) {
      return { status: 'read', contents: null }
    }
    return this.wslFileConfirmedAbsent(targetPath)
      ? { status: 'read', contents: null }
      : { status: 'unknown' }
  }

  // Why: the probe spawns wsl.exe; one answer per path per mutation, and only ever consulted when the
  // share already claims the file is gone (a write makes existsSync true, so no stale hit is possible).
  private wslFileConfirmedAbsent(targetPath: string): boolean {
    const cached = this.wslAbsentSurfaceFiles.get(targetPath)
    if (cached !== undefined) {
      return cached
    }
    const confirmed = wslUncFileExists(targetPath) === false
    this.wslAbsentSurfaceFiles.set(targetPath, confirmed)
    return confirmed
  }

  private readSurfaceCredentials(): ClaudeSurfaceFileRead {
    const paths = this.surface.getPaths()
    return this.readSurfaceFile(paths.credentialsPath, paths.surfaceKey)
  }

  private readRuntimeCredentialsFile(): string | null {
    const read = this.readSurfaceCredentials()
    // Why: callers turn this into an ownership proof; an unconfirmed read must never become one, so it
    // degrades to null and the caller leaves the file alone.
    return read.status === 'read' ? read.contents : null
  }

  private runtimeCredentialsBelongToAccount(
    credentialsJson: string | null,
    account: ClaudeManagedAccount,
    managedOauthAccount: unknown
  ): boolean {
    if (!credentialsJson) {
      return false
    }
    const identity = this.readIdentityFromCredentials(credentialsJson)
    if (
      !identity?.email ||
      (account.email && this.normalizeField(account.email) !== identity.email)
    ) {
      return false
    }
    const oauthIdentity = this.readIdentityFromOauthAccount(managedOauthAccount)
    const selectedOrganizationUuid = this.normalizeField(
      account.organizationUuid ?? oauthIdentity.organizationUuid
    )
    if (selectedOrganizationUuid) {
      return identity.organizationUuid === selectedOrganizationUuid
    }
    return !identity.organizationUuid
  }

  private clearLastWrittenRuntimeState(): void {
    this.surface.state.lastWrittenCredentialsJson = null
    this.surface.state.lastWrittenOauthAccount = null
    this.surface.state.hasLastWrittenOauthAccount = false
    this.surface.state.hasMaterializedRuntimeAuth = false
  }

  private hasUnchangedRuntimeCredentials(previouslyWrittenCredentialsJson: string | null): boolean {
    if (previouslyWrittenCredentialsJson === null) {
      return false
    }
    return this.readRuntimeCredentialsFile() === previouslyWrittenCredentialsJson
  }

  private runtimeCredentialsChangedSinceLastWrite(baselineCredentialsJson: string): boolean {
    try {
      const currentCredentialsJson = this.readRuntimeCredentialsFile()
      return (
        currentCredentialsJson !== null &&
        currentCredentialsJson !==
          (this.surface.state.lastWrittenCredentialsJson ?? baselineCredentialsJson)
      )
    } catch {
      return false
    }
  }

  private restoreRuntimeCredentials(credentialsJson: string | null): void {
    const paths = this.surface.getPaths()
    if (credentialsJson !== null) {
      this.writeRuntimeCredentials(credentialsJson)
    } else {
      rmSync(paths.credentialsPath, { force: true })
    }
  }

  private async restoreRuntimeOauthAccountIfOwned(
    oauthAccount: unknown,
    ownedOauthAccount: unknown,
    options: { allowCredentialSurfaceOwnership: boolean }
  ): Promise<void> {
    const currentOauthAccount = await this.readRuntimeOauthAccount()
    if (!this.isUsableRuntimeOauthAccount(currentOauthAccount)) {
      return
    }
    if (options.allowCredentialSurfaceOwnership) {
      await this.writeRuntimeOauthAccount(oauthAccount)
      return
    }
    if (
      (ownedOauthAccount === null || ownedOauthAccount === undefined) &&
      !options.allowCredentialSurfaceOwnership
    ) {
      return
    }
    if (!this.jsonValuesEqual(currentOauthAccount, ownedOauthAccount)) {
      return
    }
    await this.writeRuntimeOauthAccount(oauthAccount)
  }

  private async hasUnchangedActiveClaudeKeychainCredentials(
    snapshotValue: ClaudeKeychainSnapshotValue,
    previouslyWrittenCredentialsJson: string | null,
    configDir?: string
  ): Promise<boolean> {
    if (snapshotValue.status === 'unknown') {
      return false
    }
    const currentCredentialsJson =
      await this.readActiveClaudeKeychainCredentialsBestEffort(configDir)
    return (
      previouslyWrittenCredentialsJson !== null &&
      currentCredentialsJson === previouslyWrittenCredentialsJson
    )
  }

  private async restoreActiveClaudeKeychainCredentials(
    credentialsJson: string | null,
    configDir?: string
  ): Promise<void> {
    await (credentialsJson !== null
      ? writeActiveClaudeKeychainCredentials(credentialsJson, configDir)
      : deleteActiveClaudeKeychainCredentialsStrict(configDir))
  }

  private async hasActiveKeychainCredentialsForAccount(
    account: ClaudeManagedAccount,
    managedOauthAccount: unknown,
    configDir?: string
  ): Promise<boolean> {
    const currentCredentialsJson =
      await this.readActiveClaudeKeychainCredentialsBestEffort(configDir)
    return this.runtimeCredentialsBelongToAccount(
      currentCredentialsJson,
      account,
      managedOauthAccount
    )
  }

  // Why: `.claude.json` carries the full project/MCP history and lives over 9P for WSL surfaces, so it is never read on the main thread synchronously.
  private async readRuntimeOauthAccount(): Promise<unknown> {
    const config = await this.readRuntimeConfig()
    if (config.status === 'invalid') {
      return RUNTIME_OAUTH_ACCOUNT_PARSE_ERROR
    }
    if (config.status === 'unknown') {
      return RUNTIME_OAUTH_ACCOUNT_UNREADABLE
    }
    return config.record.oauthAccount ?? null
  }

  private isUsableRuntimeOauthAccount(value: unknown): boolean {
    return value !== RUNTIME_OAUTH_ACCOUNT_PARSE_ERROR && value !== RUNTIME_OAUTH_ACCOUNT_UNREADABLE
  }

  private async runtimeOauthAccountMatches(managedOauthAccount: unknown): Promise<boolean> {
    if (managedOauthAccount === null || managedOauthAccount === undefined) {
      return false
    }
    const currentOauthAccount = await this.readRuntimeOauthAccount()
    if (!this.isUsableRuntimeOauthAccount(currentOauthAccount)) {
      return false
    }
    return this.jsonValuesEqual(currentOauthAccount, managedOauthAccount)
  }

  private async writeRuntimeOauthAccount(oauthAccount: unknown): Promise<boolean> {
    const configPath = this.surface.getPaths().configPath
    const existing = await this.readRuntimeConfig()
    if (existing.status !== 'read') {
      return false
    }
    // Why: the cached read hands out the same object to every caller this mutation, so edit a copy.
    const record = { ...existing.record }
    if (oauthAccount === null || oauthAccount === undefined) {
      delete record.oauthAccount
    } else {
      record.oauthAccount = oauthAccount
    }
    const serialized = `${JSON.stringify(record, null, 2)}\n`
    // Why: the async read above already holds the current bytes; re-reading a multi-MB
    // ~/.claude.json over 9P just to compare would block the main thread all over again.
    if (serialized === existing.contents) {
      return true
    }
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileAtomically(configPath, serialized, { mode: 0o600 })
    this.cachedRuntimeConfigRead = {
      path: configPath,
      read: { status: 'read', record, contents: serialized }
    }
    return true
  }

  private jsonValuesEqual(left: unknown, right: unknown): boolean {
    return (
      JSON.stringify(this.sortJsonValue(left ?? null)) ===
      JSON.stringify(this.sortJsonValue(right ?? null))
    )
  }

  private sortJsonValue(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.sortJsonValue(item))
    }
    const record = this.asRecord(value)
    if (!record) {
      return value
    }
    return Object.fromEntries(
      Object.entries(record)
        .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
        .map(([key, nestedValue]) => [key, this.sortJsonValue(nestedValue)])
    )
  }

  private isSystemDefaultSnapshot(value: unknown): value is ClaudeSystemDefaultSnapshot {
    const snapshot = this.asRecord(value)
    return (
      snapshot !== null &&
      Object.hasOwn(snapshot, 'credentialsJson') &&
      this.isOptionalNullableString(snapshot.credentialsJson) &&
      this.isOptionalNullableString(snapshot.keychainCredentialsJson) &&
      this.isOptionalNullableString(snapshot.scopedKeychainCredentialsJson) &&
      this.isOptionalNullableString(snapshot.legacyKeychainCredentialsJson) &&
      this.isOptionalBoolean(snapshot.scopedKeychainCredentialsCaptured) &&
      this.isOptionalBoolean(snapshot.legacyKeychainCredentialsCaptured) &&
      this.hasValidKeychainSnapshotValue(snapshot, 'scoped') &&
      this.hasValidKeychainSnapshotValue(snapshot, 'legacy') &&
      (snapshot.capturedAt === undefined || typeof snapshot.capturedAt === 'number')
    )
  }

  private isOptionalNullableString(value: unknown): boolean {
    return value === undefined || value === null || typeof value === 'string'
  }

  private isOptionalBoolean(value: unknown): boolean {
    return value === undefined || typeof value === 'boolean'
  }

  private snapshotKeychainCredentials(
    credentialsJson: string | null,
    previousSnapshot: ClaudeSystemDefaultSnapshot | null | undefined,
    service: 'scoped' | 'legacy',
    managedCredentialsJson: string | undefined
  ): string | null {
    if (managedCredentialsJson && credentialsJson === managedCredentialsJson && previousSnapshot) {
      const previousValue = this.readKeychainSnapshotValue(previousSnapshot, service)
      if (previousValue.status === 'captured') {
        return previousValue.credentialsJson
      }
    }
    return credentialsJson
  }

  private hasValidKeychainSnapshotValue(
    snapshot: Record<string, unknown>,
    service: 'scoped' | 'legacy'
  ): boolean {
    const capturedKey =
      service === 'scoped'
        ? 'scopedKeychainCredentialsCaptured'
        : 'legacyKeychainCredentialsCaptured'
    if (snapshot[capturedKey] === false) {
      return true
    }
    const credentialsKey =
      service === 'scoped' ? 'scopedKeychainCredentialsJson' : 'legacyKeychainCredentialsJson'
    return (
      Object.hasOwn(snapshot, credentialsKey) || Object.hasOwn(snapshot, 'keychainCredentialsJson')
    )
  }

  private readKeychainSnapshotValue(
    snapshot: ClaudeSystemDefaultSnapshot | null,
    service: 'scoped' | 'legacy'
  ): ClaudeKeychainSnapshotValue {
    if (!snapshot) {
      return { status: 'captured', credentialsJson: null }
    }
    const capturedKey =
      service === 'scoped'
        ? 'scopedKeychainCredentialsCaptured'
        : 'legacyKeychainCredentialsCaptured'
    if (snapshot[capturedKey] === false) {
      return { status: 'unknown' }
    }
    const credentialsKey =
      service === 'scoped' ? 'scopedKeychainCredentialsJson' : 'legacyKeychainCredentialsJson'
    if (Object.hasOwn(snapshot, credentialsKey)) {
      return {
        status: 'captured',
        credentialsJson: snapshot[credentialsKey] ?? null
      }
    }
    return {
      status: 'captured',
      credentialsJson: snapshot.keychainCredentialsJson
    }
  }

  private async readAggregateClaudeKeychainCredentialsBestEffort(
    configDir: string
  ): Promise<string | null> {
    try {
      return await readActiveClaudeKeychainCredentials(configDir)
    } catch (error) {
      console.warn('[claude-runtime-auth] Failed to read Claude Keychain credentials:', error)
      return null
    }
  }

  private async readActiveClaudeKeychainCredentialsBestEffort(
    configDir?: string
  ): Promise<string | null> {
    try {
      return await readActiveClaudeKeychainCredentialsStrict(configDir)
    } catch (error) {
      console.warn('[claude-runtime-auth] Failed to read Claude Keychain credentials:', error)
      return null
    }
  }

  private async readActiveClaudeKeychainCredentialsForSnapshot(
    configDir?: string
  ): Promise<ClaudeKeychainReadResult> {
    try {
      return {
        status: 'captured',
        credentialsJson: await readActiveClaudeKeychainCredentialsStrict(configDir)
      }
    } catch (error) {
      console.warn('[claude-runtime-auth] Failed to read Claude Keychain credentials:', error)
      return { status: 'failed' }
    }
  }

  private writeRuntimeCredentials(contents: string): void {
    const credentialsPath = this.surface.getPaths().credentialsPath
    mkdirSync(dirname(credentialsPath), { recursive: true })
    // Why: skip unchanged rewrites to dodge Windows EPERM contention (#1507); re-verify the file since another Claude may have rewritten it.
    if (
      this.surface.state.lastWrittenCredentialsJson === contents &&
      this.fileContentsEqual(credentialsPath, contents)
    ) {
      this.ensureOwnerOnlyMode(credentialsPath)
      return
    }
    if (this.fileContentsEqual(credentialsPath, contents)) {
      this.ensureOwnerOnlyMode(credentialsPath)
      this.surface.state.lastWrittenCredentialsJson = contents
      return
    }
    writeFileAtomically(credentialsPath, contents, { mode: 0o600 })
    this.surface.state.lastWrittenCredentialsJson = contents
  }

  private writeJson(targetPath: string, value: unknown): void {
    const serialized = `${JSON.stringify(value, null, 2)}\n`
    mkdirSync(dirname(targetPath), { recursive: true })
    // Why: same Windows contention reason as writeRuntimeCredentials.
    if (this.fileContentsEqual(targetPath, serialized)) {
      return
    }
    writeFileAtomically(targetPath, serialized, { mode: 0o600 })
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

  private async readRuntimeConfig(): Promise<ClaudeRuntimeConfigRead> {
    const configPath = this.surface.getPaths().configPath
    if (this.cachedRuntimeConfigRead?.path === configPath) {
      return this.cachedRuntimeConfigRead.read
    }
    const read = await this.loadRuntimeConfig(configPath)
    this.cachedRuntimeConfigRead = { path: configPath, read }
    return read
  }

  private async loadRuntimeConfig(configPath: string): Promise<ClaudeRuntimeConfigRead> {
    let contents: string
    try {
      contents = await readFile(configPath, 'utf-8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Why: unreadable config is unknown external state; callers must not erase user or Claude-owned settings.
        return { status: 'invalid' }
      }
      // Why: the caller rewrites this file wholesale, so only the distro's own answer may be read as "absent".
      return this.surface.key === HOST_AUTH_SURFACE_KEY || this.wslFileConfirmedAbsent(configPath)
        ? { status: 'read', record: {}, contents: null }
        : { status: 'unknown' }
    }
    try {
      const record = this.asRecord(JSON.parse(contents) as unknown)
      return record ? { status: 'read', record, contents } : { status: 'invalid' }
    } catch {
      return { status: 'invalid' }
    }
  }

  private getRuntimeMetadataDir(): string {
    const metadataDir = join(app.getPath('userData'), 'claude-runtime-auth')
    mkdirSync(metadataDir, { recursive: true })
    return metadataDir
  }

  private getSurfaceSnapshotPath(surfaceKey: string): string {
    return join(this.getRuntimeMetadataDir(), authSurfaceSnapshotFileName(surfaceKey))
  }

  private getSystemDefaultSnapshotPath(): string {
    return this.getSurfaceSnapshotPath(this.surface.key)
  }
}
