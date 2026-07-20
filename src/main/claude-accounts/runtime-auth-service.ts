/* eslint-disable max-lines -- Why: keeps file/Keychain/snapshot/env-patch auth semantics together so PTY launch and quota-fetch paths can't drift. */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
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
import { getDefaultWslDistro, getWslHome, toWindowsWslPath } from '../wsl'
import { buildEncodedWslBashCommand } from '../wsl-bash-command'
import { hasLiveClaudePtys } from './live-pty-gate'
import { isOauthTokenExpiring, refreshClaudeOauthCredentials } from './oauth-refresh'
import { ClaudeRuntimePathResolver } from './runtime-paths'
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
  capturedAt: number
}

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

const RUNTIME_OAUTH_ACCOUNT_PARSE_ERROR = Symbol('runtime-oauth-account-parse-error')

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

export class ClaudeRuntimeAuthService {
  private readonly pathResolver = new ClaudeRuntimePathResolver()
  private mutationQueue: Promise<unknown> = Promise.resolve()
  private lastSyncedAccountId: string | null = null
  // Why: creds Orca last wrote to the shared file; a mismatch on managed→default transition means an external login overwrote it, so adopt it as the new default.
  private lastWrittenCredentialsJson: string | null = null
  private hasMaterializedRuntimeAuth = false
  private hasLastWrittenOauthAccount = false
  private lastWrittenOauthAccount: unknown = null
  private skipNextReadBackForAccountId: string | null = null
  private managedRefreshDeferredByLivePtyAccountId: string | null = null

  constructor(private readonly store: Store) {
    this.initializeLastSyncedState()
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

  async forceMaterializeCurrentSelectionForRollback(): Promise<void> {
    await this.serializeMutation(async () => {
      const settings = this.store.getSettings()
      if (!settings.activeClaudeManagedAccountId) {
        const previousAccount = this.getActiveAccount(
          settings.claudeManagedAccounts,
          this.lastSyncedAccountId
        )
        await this.restoreSystemDefaultSnapshot(
          previousAccount ? await this.readManagedCredentials(previousAccount) : null,
          previousAccount ? this.readManagedOauthAccount(previousAccount) : undefined
        )
        this.lastSyncedAccountId = null
        return
      }
      await this.doSyncForCurrentSelection()
    })
  }

  getRuntimeConfigDir(): string {
    return this.pathResolver.getRuntimePaths().configDir
  }

  private initializeLastSyncedState(): void {
    const settings = this.store.getSettings()
    this.lastSyncedAccountId = getSelectedClaudeAccountIdForTarget(settings, { runtime: 'host' })
  }

  private async safeSyncForCurrentSelection(): Promise<void> {
    try {
      await this.syncForCurrentSelection()
    } catch (error) {
      console.warn('[claude-runtime-auth] Failed to sync runtime auth state:', error)
    }
  }

  private serializeMutation<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(fn, fn)
    this.mutationQueue = next.catch(() => {})
    return next
  }

  private async doSyncForCurrentSelection(target?: ClaudeAccountSelectionTarget): Promise<void> {
    const settings = this.store.getSettings()
    const effectiveTarget = this.resolveWslDefaultTarget(target)
    const normalizedTarget = normalizeClaudeAccountSelectionTarget(effectiveTarget)
    const activeAccountId = getSelectedClaudeAccountIdForTarget(settings, normalizedTarget)
    const activeAccount = this.getActiveAccount(settings.claudeManagedAccounts, activeAccountId)
    const previousAccount = this.getActiveAccount(
      settings.claudeManagedAccounts,
      this.lastSyncedAccountId
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
            this.liveRuntimeCredentialsCanUpdateActiveAccount(
              outgoingReadBackResult.runtimeCredentialsJson,
              previousAccount,
              previousManagedCredentialsJson,
              previousManagedOauthAccount
            )
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
        return
      }
      if (this.lastSyncedAccountId !== null) {
        await (previousAccount
          ? this.restoreSystemDefaultSnapshot(
              previousManagedCredentialsJson,
              previousManagedOauthAccount
            )
          : this.restoreSystemDefaultSnapshot(this.lastWrittenCredentialsJson, undefined))
        this.lastSyncedAccountId = null
      }
      return
    }

    if (activeAccount.managedAuthRuntime === 'wsl') {
      if (!this.getOwnedManagedAuthPath(activeAccount)) {
        console.warn(
          '[claude-runtime-auth] Active WSL managed account is not owned by Orca, restoring system default'
        )
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
        return
      }
      const credentialsJson = await this.readManagedCredentials(activeAccount)
      if (!credentialsJson || !this.isValidCredentialsJsonObject(credentialsJson)) {
        console.warn(
          '[claude-runtime-auth] Active WSL managed account is missing or has invalid credentials, restoring system default'
        )
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
        return
      }
      // Why: WSL managed accounts are isolated by their Linux CLAUDE_CONFIG_DIR; materializing into Windows ~/.claude would mix two auth stores.
      this.clearLastWrittenRuntimeState()
      return
    }

    if (!this.getOwnedManagedAuthPath(activeAccount)) {
      console.warn(
        '[claude-runtime-auth] Active managed account is not owned by Orca, restoring system default'
      )
      if (this.lastSyncedAccountId !== null) {
        if (
          previousAccount &&
          (previousAccount.id !== activeAccount.id ||
            this.hasMaterializedRuntimeAuth ||
            this.runtimeOauthAccountMatches(this.readManagedOauthAccount(previousAccount)))
        ) {
          await this.restoreSystemDefaultSnapshotForMissingManagedCredentials(
            previousAccount,
            previousManagedOauthAccount
          )
        } else if (!previousAccount && this.hasMaterializedRuntimeAuth) {
          await this.restoreSystemDefaultSnapshot(this.lastWrittenCredentialsJson, undefined)
        }
      }
      this.store.updateSettings({ activeClaudeManagedAccountId: null })
      this.lastSyncedAccountId = null
      return
    }

    let credentialsJson = await this.readManagedCredentials(activeAccount)
    if (!credentialsJson || !this.isValidCredentialsJsonObject(credentialsJson)) {
      console.warn(
        '[claude-runtime-auth] Active managed account is missing or has invalid credentials, restoring system default'
      )
      if (this.lastSyncedAccountId !== null) {
        if (
          previousAccount &&
          (previousAccount.id !== activeAccount.id ||
            this.hasMaterializedRuntimeAuth ||
            this.runtimeOauthAccountMatches(previousManagedOauthAccount))
        ) {
          await this.restoreSystemDefaultSnapshotForMissingManagedCredentials(
            previousAccount,
            previousManagedOauthAccount
          )
        } else if (!previousAccount && this.hasMaterializedRuntimeAuth) {
          await this.restoreSystemDefaultSnapshot(this.lastWrittenCredentialsJson, undefined)
        }
      }
      this.store.updateSettings({ activeClaudeManagedAccountId: null })
      this.lastSyncedAccountId = null
      return
    }

    if (this.lastSyncedAccountId === null) {
      const paths = this.pathResolver.getRuntimePaths()
      const runtimeCredentialsJson = existsSync(paths.credentialsPath)
        ? readFileSync(paths.credentialsPath, 'utf-8')
        : null
      await this.captureSystemDefaultSnapshotForManagedEntry(
        runtimeCredentialsJson,
        credentialsJson
      )
    }

    // Why: the CLI writes refreshed tokens to .credentials.json; if runtime differs from our last write, preserve them to managed storage before overwriting.
    if (this.lastSyncedAccountId === activeAccount.id) {
      if (this.skipNextReadBackForAccountId === activeAccount.id) {
        this.skipNextReadBackForAccountId = null
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
            this.liveRuntimeCredentialsCanUpdateActiveAccount(
              readBackResult.runtimeCredentialsJson,
              activeAccount,
              credentialsJson,
              this.readManagedOauthAccount(activeAccount)
            )
          ) {
            // Why: this Claude launched under the active managed account, but persistence still needs positive account proof.
            await this.writeManagedCredentials(activeAccount, readBackResult.runtimeCredentialsJson)
            credentialsJson = readBackResult.runtimeCredentialsJson
          } else {
            // Why: while Claude runs, an unknown refresh may belong to a live session; rewriting stale managed auth logs it out.
            console.warn(
              '[claude-runtime-auth] Preserving changed Claude runtime credentials while live Claude terminals are running'
            )
            this.lastSyncedAccountId = activeAccount.id
            this.hasMaterializedRuntimeAuth = true
            return
          }
        }
      }
    }

    if (this.lastSyncedAccountId !== activeAccount.id) {
      this.skipNextReadBackForAccountId = null
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

    const paths = this.pathResolver.getRuntimePaths()
    this.writeRuntimeCredentials(credentialsJson)
    if (process.platform === 'darwin') {
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
    if (this.writeRuntimeOauthAccount(managedOauthAccount)) {
      this.lastWrittenOauthAccount = managedOauthAccount
      this.hasLastWrittenOauthAccount = true
    } else {
      this.lastWrittenOauthAccount = null
      this.hasLastWrittenOauthAccount = false
    }
    this.lastSyncedAccountId = activeAccount.id
    this.hasMaterializedRuntimeAuth = true
  }

  // Why: re-auth/add-account write fresh managed tokens; skip the next read-back so stale runtime tokens can't overwrite them.
  clearLastWrittenCredentialsJson(
    accountId = this.store.getSettings().activeClaudeManagedAccountId
  ): void {
    if (accountId === this.store.getSettings().activeClaudeManagedAccountId) {
      this.lastWrittenCredentialsJson = null
    }
    this.skipNextReadBackForAccountId = accountId
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
        this.lastWrittenCredentialsJson === null
          ? candidates
          : candidates.filter(
              (candidate) => candidate.credentialsJson !== this.lastWrittenCredentialsJson
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
        if (this.lastWrittenCredentialsJson === null) {
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
        acceptedCandidates.push({ credentialsJson: runtimeContents.credentialsJson, match })
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
        this.lastWrittenCredentialsJson = runtimeContents
        if (process.platform === 'darwin') {
          const paths = this.pathResolver.getRuntimePaths()
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
    const paths = this.pathResolver.getRuntimePaths()
    const fileCredentials = existsSync(paths.credentialsPath)
      ? readFileSync(paths.credentialsPath, 'utf-8')
      : null
    const runtimeOauthAccount = this.readRuntimeOauthAccount()
    const candidates: ClaudeRuntimeCredentialCandidate[] = []
    const pushCandidate = (credentialsJson: string | null): void => {
      if (
        credentialsJson &&
        !candidates.some((candidate) => candidate.credentialsJson === credentialsJson)
      ) {
        candidates.push({ credentialsJson, runtimeOauthAccount })
      }
    }
    if (process.platform === 'darwin') {
      const scopedKeychainCredentials = await this.readActiveClaudeKeychainCredentialsBestEffort(
        paths.configDir
      )
      const legacyKeychainCredentials = await this.readActiveClaudeKeychainCredentialsBestEffort()
      if (this.lastWrittenCredentialsJson === null) {
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
    const normalizedTarget = this.resolveWslDefaultTarget(
      target ?? this.getDefaultAccountSelectionTarget(settings)
    )
    const activeAccountId = getSelectedClaudeAccountIdForTarget(settings, normalizedTarget)
    const activeAccount = this.getActiveAccount(settings.claudeManagedAccounts, activeAccountId)
    if (
      normalizeClaudeAccountSelectionTarget(normalizedTarget).runtime === 'wsl' &&
      activeAccount?.managedAuthRuntime === 'wsl' &&
      activeAccount.wslLinuxAuthPath
    ) {
      return {
        configDir: activeAccount.managedAuthPath,
        runtime: 'wsl',
        wslDistro: activeAccount.wslDistro ?? null,
        wslLinuxConfigDir: activeAccount.wslLinuxAuthPath,
        envPatch: { CLAUDE_CONFIG_DIR: activeAccount.wslLinuxAuthPath },
        stripAuthEnv: true,
        provenance: `managed:${activeAccount.id}:wsl:${activeAccount.wslDistro ?? ''}`
      }
    }
    if (normalizeClaudeAccountSelectionTarget(normalizedTarget).runtime === 'wsl') {
      const distro =
        normalizeClaudeAccountSelectionTarget(normalizedTarget).wslDistro ?? getDefaultWslDistro()
      const wslHome = distro ? getWslHome(distro) : null
      const wslHomeInfo = wslHome ? parseWslUncPath(wslHome) : null
      if (distro && wslHome && wslHomeInfo) {
        const windowsConfigDir = join(wslHome, '.claude')
        const linuxConfigDir = `${wslHomeInfo.linuxPath.replace(/\/$/, '')}/.claude`
        return {
          configDir: windowsConfigDir,
          runtime: 'wsl',
          wslDistro: distro,
          wslLinuxConfigDir: linuxConfigDir,
          envPatch: {},
          stripAuthEnv: true,
          provenance: `wsl:${distro}:system`
        }
      }
      return {
        configDir: paths.configDir,
        runtime: 'wsl',
        wslDistro: normalizeClaudeAccountSelectionTarget(normalizedTarget).wslDistro,
        wslLinuxConfigDir: null,
        envPatch: {},
        stripAuthEnv: true,
        provenance: `wsl:${normalizeClaudeAccountSelectionTarget(normalizedTarget).wslDistro ?? '__default__'}:system`
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
    if (process.platform === 'win32' && settings.localAccountRuntime === 'wsl') {
      // Why: auth defaults follow account runtime settings, not legacy terminal WSL settings that can outlive the Terminal UI.
      return { runtime: 'wsl', wslDistro: settings.localAccountWslDistro ?? null }
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
    return { kind: matches.length === 0 && unverifiableCount === 0 ? 'none' : 'ambiguous' }
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

  private liveRuntimeCredentialsCanUpdateActiveAccount(
    runtimeCredentialsJson: string,
    account: ClaudeManagedAccount,
    managedCredentialsJson: string,
    managedOauthAccount: unknown
  ): boolean {
    const match = this.runtimeCredentialsMatchAccount(
      runtimeCredentialsJson,
      this.readRuntimeOauthAccount(),
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
    const runtimeOauthIdentity = this.readIdentityFromOauthAccount(this.readRuntimeOauthAccount())
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

  private async captureSystemDefaultSnapshotForManagedEntry(
    runtimeCredentialsJson: string | null,
    managedCredentialsJson: string
  ): Promise<void> {
    const snapshotPath = this.getSystemDefaultSnapshotPath()
    const existingSnapshot = this.readSystemDefaultSnapshot(snapshotPath)
    if (runtimeCredentialsJson !== managedCredentialsJson) {
      await this.captureSystemDefaultSnapshot({
        force: true,
        previousSnapshot: existingSnapshot,
        managedCredentialsJson
      })
      return
    }
    if (existingSnapshot) {
      await this.captureSystemDefaultSnapshot({
        force: true,
        credentialsJsonOverride: existingSnapshot.credentialsJson,
        previousSnapshot: existingSnapshot,
        managedCredentialsJson
      })
      return
    }
    await this.captureSystemDefaultSnapshot({ force: false })
  }

  private async captureSystemDefaultSnapshot(options: {
    force: boolean
    credentialsJsonOverride?: string | null
    previousSnapshot?: ClaudeSystemDefaultSnapshot | null
    managedCredentialsJson?: string
  }): Promise<void> {
    const snapshotPath = this.getSystemDefaultSnapshotPath()
    if (!options.force && existsSync(snapshotPath)) {
      return
    }

    const paths = this.pathResolver.getRuntimePaths()
    const credentialsJson =
      options.credentialsJsonOverride !== undefined
        ? options.credentialsJsonOverride
        : existsSync(paths.credentialsPath)
          ? readFileSync(paths.credentialsPath, 'utf-8')
          : null
    const keychainCredentialsJson = await this.readAggregateClaudeKeychainCredentialsBestEffort(
      paths.configDir
    )
    const scopedKeychainCredentials =
      process.platform === 'darwin'
        ? await this.readActiveClaudeKeychainCredentialsForSnapshot(paths.configDir)
        : ({ status: 'captured', credentialsJson: null } as const)
    const legacyKeychainCredentialsJson =
      process.platform === 'darwin'
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
    const configOauthAccount = this.readRuntimeOauthAccount()
    const snapshot: ClaudeSystemDefaultSnapshot = {
      credentialsJson,
      configOauthAccount:
        configOauthAccount === RUNTIME_OAUTH_ACCOUNT_PARSE_ERROR ? null : configOauthAccount,
      keychainCredentialsJson,
      scopedKeychainCredentialsJson,
      legacyKeychainCredentialsJson: legacyKeychainSnapshotJson,
      scopedKeychainCredentialsCaptured: scopedKeychainCredentials.status === 'captured',
      legacyKeychainCredentialsCaptured: legacyKeychainCredentialsJson.status === 'captured',
      capturedAt: Date.now()
    }
    this.writeJson(snapshotPath, snapshot)
  }

  private async restoreSystemDefaultSnapshot(
    ownedCredentialsJson?: string | null,
    ownedOauthAccount?: unknown
  ): Promise<void> {
    const snapshotPath = this.getSystemDefaultSnapshotPath()
    const paths = this.pathResolver.getRuntimePaths()
    const previouslyWrittenCredentialsJson =
      this.lastWrittenCredentialsJson ?? ownedCredentialsJson ?? null
    const snapshot = this.readSystemDefaultSnapshot(snapshotPath)

    const fileCredentialsOwned = this.hasUnchangedRuntimeCredentials(
      previouslyWrittenCredentialsJson
    )
    let hasCredentialSurfaceOwnership = fileCredentialsOwned
    // Why: prove ownership before mutating anything, and restore OAuth first so a failure leaves the credential proof intact for retry.
    this.lastWrittenCredentialsJson = previouslyWrittenCredentialsJson
    let scopedSnapshot: ClaudeKeychainSnapshotValue | null = null
    let legacySnapshot: ClaudeKeychainSnapshotValue | null = null
    let scopedKeychainOwned = false
    let legacyKeychainOwned = false
    if (process.platform === 'darwin') {
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
    this.restoreRuntimeOauthAccountIfOwned(
      snapshot?.configOauthAccount ?? null,
      this.getOwnedRuntimeOauthBaseline(ownedOauthAccount, hasCredentialSurfaceOwnership),
      { allowCredentialSurfaceOwnership: hasCredentialSurfaceOwnership }
    )
    if (fileCredentialsOwned) {
      this.restoreRuntimeCredentials(snapshot?.credentialsJson ?? null)
    }
    if (process.platform === 'darwin') {
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
    this.lastWrittenCredentialsJson = null
    this.lastWrittenOauthAccount = null
    this.hasLastWrittenOauthAccount = false
    this.hasMaterializedRuntimeAuth = false
  }

  private getOwnedRuntimeOauthBaseline(
    ownedOauthAccount: unknown,
    hasCredentialSurfaceOwnership: boolean
  ): unknown {
    if (this.hasLastWrittenOauthAccount) {
      return this.lastWrittenOauthAccount
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
    const paths = this.pathResolver.getRuntimePaths()
    const fileCredentialsOwned = this.runtimeCredentialsBelongToAccount(
      this.readRuntimeCredentialsFile(),
      account,
      managedOauthAccount
    )
    let scopedKeychainOwned = false
    let legacyKeychainOwned = false
    if (process.platform === 'darwin') {
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
    this.restoreRuntimeOauthAccountIfOwned(
      null,
      this.getOwnedRuntimeOauthBaseline(managedOauthAccount, hasCredentialSurfaceOwnership),
      {
        allowCredentialSurfaceOwnership: hasCredentialSurfaceOwnership
      }
    )
    if (fileCredentialsOwned) {
      rmSync(paths.credentialsPath, { force: true })
    }
    if (process.platform === 'darwin') {
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
    const paths = this.pathResolver.getRuntimePaths()
    const fileCredentialsOwned = this.runtimeCredentialsBelongToAccount(
      this.readRuntimeCredentialsFile(),
      account,
      managedOauthAccount
    )
    let scopedSnapshot: ClaudeKeychainSnapshotValue | null = null
    let legacySnapshot: ClaudeKeychainSnapshotValue | null = null
    let scopedKeychainOwned = false
    let legacyKeychainOwned = false
    if (process.platform === 'darwin') {
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
    this.restoreRuntimeOauthAccountIfOwned(
      snapshot.configOauthAccount,
      this.getOwnedRuntimeOauthBaseline(managedOauthAccount, hasCredentialSurfaceOwnership),
      {
        allowCredentialSurfaceOwnership: hasCredentialSurfaceOwnership
      }
    )
    if (fileCredentialsOwned) {
      this.restoreRuntimeCredentials(snapshot.credentialsJson)
    }
    if (process.platform === 'darwin') {
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

  private readRuntimeCredentialsFile(): string | null {
    const credentialsPath = this.pathResolver.getRuntimePaths().credentialsPath
    return existsSync(credentialsPath) ? readFileSync(credentialsPath, 'utf-8') : null
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
    this.lastWrittenCredentialsJson = null
    this.lastWrittenOauthAccount = null
    this.hasLastWrittenOauthAccount = false
    this.hasMaterializedRuntimeAuth = false
  }

  private hasUnchangedRuntimeCredentials(previouslyWrittenCredentialsJson: string | null): boolean {
    if (previouslyWrittenCredentialsJson === null) {
      return false
    }
    const paths = this.pathResolver.getRuntimePaths()
    const currentCredentialsJson = existsSync(paths.credentialsPath)
      ? readFileSync(paths.credentialsPath, 'utf-8')
      : null
    return currentCredentialsJson === previouslyWrittenCredentialsJson
  }

  private runtimeCredentialsChangedSinceLastWrite(baselineCredentialsJson: string): boolean {
    const paths = this.pathResolver.getRuntimePaths()
    try {
      const currentCredentialsJson = existsSync(paths.credentialsPath)
        ? readFileSync(paths.credentialsPath, 'utf-8')
        : null
      return (
        currentCredentialsJson !== null &&
        currentCredentialsJson !== (this.lastWrittenCredentialsJson ?? baselineCredentialsJson)
      )
    } catch {
      return false
    }
  }

  private restoreRuntimeCredentials(credentialsJson: string | null): void {
    const paths = this.pathResolver.getRuntimePaths()
    if (credentialsJson !== null) {
      this.writeRuntimeCredentials(credentialsJson)
    } else {
      rmSync(paths.credentialsPath, { force: true })
    }
  }

  private restoreRuntimeOauthAccountIfOwned(
    oauthAccount: unknown,
    ownedOauthAccount: unknown,
    options: { allowCredentialSurfaceOwnership: boolean }
  ): void {
    const currentOauthAccount = this.readRuntimeOauthAccount()
    if (currentOauthAccount === RUNTIME_OAUTH_ACCOUNT_PARSE_ERROR) {
      return
    }
    if (options.allowCredentialSurfaceOwnership) {
      this.writeRuntimeOauthAccount(oauthAccount)
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
    this.writeRuntimeOauthAccount(oauthAccount)
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

  private readRuntimeOauthAccount(): unknown {
    const configPath = this.pathResolver.getRuntimePaths().configPath
    if (!existsSync(configPath)) {
      return null
    }
    try {
      const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as unknown
      const record = this.asRecord(parsed)
      if (!record) {
        return RUNTIME_OAUTH_ACCOUNT_PARSE_ERROR
      }
      return record.oauthAccount ?? null
    } catch {
      return RUNTIME_OAUTH_ACCOUNT_PARSE_ERROR
    }
  }

  private runtimeOauthAccountMatches(managedOauthAccount: unknown): boolean {
    if (managedOauthAccount === null || managedOauthAccount === undefined) {
      return false
    }
    const currentOauthAccount = this.readRuntimeOauthAccount()
    if (currentOauthAccount === RUNTIME_OAUTH_ACCOUNT_PARSE_ERROR) {
      return false
    }
    return this.jsonValuesEqual(currentOauthAccount, managedOauthAccount)
  }

  private writeRuntimeOauthAccount(oauthAccount: unknown): boolean {
    const configPath = this.pathResolver.getRuntimePaths().configPath
    const existing = this.readJsonObject(configPath)
    if (existing === null) {
      return false
    }
    if (oauthAccount === null || oauthAccount === undefined) {
      delete existing.oauthAccount
    } else {
      existing.oauthAccount = oauthAccount
    }
    this.writeJson(configPath, existing)
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
    return { status: 'captured', credentialsJson: snapshot.keychainCredentialsJson }
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
    const credentialsPath = this.pathResolver.getRuntimePaths().credentialsPath
    mkdirSync(dirname(credentialsPath), { recursive: true })
    // Why: skip unchanged rewrites to dodge Windows EPERM contention (#1507); re-verify the file since another Claude may have rewritten it.
    if (
      this.lastWrittenCredentialsJson === contents &&
      this.fileContentsEqual(credentialsPath, contents)
    ) {
      this.ensureOwnerOnlyMode(credentialsPath)
      return
    }
    if (this.fileContentsEqual(credentialsPath, contents)) {
      this.ensureOwnerOnlyMode(credentialsPath)
      this.lastWrittenCredentialsJson = contents
      return
    }
    writeFileAtomically(credentialsPath, contents, { mode: 0o600 })
    this.lastWrittenCredentialsJson = contents
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

  private readJsonObject(targetPath: string): Record<string, unknown> | null {
    if (!existsSync(targetPath)) {
      return {}
    }
    try {
      const parsed = JSON.parse(readFileSync(targetPath, 'utf-8')) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // Why: invalid config is unknown external state; return null so we don't erase user or Claude-owned settings.
      return null
    }
    return null
  }

  private getRuntimeMetadataDir(): string {
    const metadataDir = join(app.getPath('userData'), 'claude-runtime-auth')
    mkdirSync(metadataDir, { recursive: true })
    return metadataDir
  }

  private getSystemDefaultSnapshotPath(): string {
    return join(this.getRuntimeMetadataDir(), 'system-default-auth.json')
  }
}
