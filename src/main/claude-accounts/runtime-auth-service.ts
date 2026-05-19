/* eslint-disable max-lines -- Why: Claude account switching has one safety
boundary: runtime auth materialization. Keeping file, Keychain, snapshot, and
env-patch semantics together prevents PTY launch and quota fetch paths drifting. */
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
import { hasLiveClaudePtys } from './live-pty-gate'
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

export type ClaudeRuntimeAuthPreparation = {
  configDir: string
  envPatch: ClaudeEnvPatch
  stripAuthEnv: boolean
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
  email: string | null
  organizationUuid: string | null
}

type ClaudeReadBackResult =
  | { status: 'unchanged' | 'persisted' }
  | { status: 'rejected'; runtimeCredentialsChanged: boolean; runtimeCredentialsJson?: string }
type ClaudeReadBackMatch =
  | { kind: 'matched'; account: ClaudeManagedAccount; managedCredentialsJson: string }
  | { kind: 'none' | 'ambiguous' }
type ClaudeKeychainReadResult =
  | { status: 'captured'; credentialsJson: string | null }
  | { status: 'failed' }
type ClaudeKeychainSnapshotValue =
  | { status: 'captured'; credentialsJson: string | null }
  | { status: 'unknown' }

const RUNTIME_OAUTH_ACCOUNT_PARSE_ERROR = Symbol('runtime-oauth-account-parse-error')

export class ClaudeRuntimeAuthService {
  private readonly pathResolver = new ClaudeRuntimePathResolver()
  private mutationQueue: Promise<unknown> = Promise.resolve()
  private lastSyncedAccountId: string | null = null
  // Why: tracks the credentials Orca last wrote to the shared credentials file.
  // On managed→system-default transition, if the file differs from this value,
  // an external login (e.g. `claude auth login`) overwrote it — so Orca adopts
  // the file as the new system default instead of restoring a stale snapshot.
  private lastWrittenCredentialsJson: string | null = null
  private hasMaterializedRuntimeAuth = false
  private hasLastWrittenOauthAccount = false
  private lastWrittenOauthAccount: unknown = null
  private skipNextReadBackForAccountId: string | null = null

  constructor(private readonly store: Store) {
    this.initializeLastSyncedState()
    void this.safeSyncForCurrentSelection()
  }

  async prepareForClaudeLaunch(): Promise<ClaudeRuntimeAuthPreparation> {
    await this.syncForCurrentSelection()
    return this.getPreparation()
  }

  async prepareForRateLimitFetch(): Promise<ClaudeRuntimeAuthPreparation> {
    await this.syncForCurrentSelection()
    return this.getPreparation()
  }

  async syncForCurrentSelection(): Promise<void> {
    await this.serializeMutation(() => this.doSyncForCurrentSelection())
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
    this.lastSyncedAccountId = settings.activeClaudeManagedAccountId
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

  private async doSyncForCurrentSelection(): Promise<void> {
    const settings = this.store.getSettings()
    const activeAccount = this.getActiveAccount(
      settings.claudeManagedAccounts,
      settings.activeClaudeManagedAccountId
    )
    const previousAccount = this.getActiveAccount(
      settings.claudeManagedAccounts,
      this.lastSyncedAccountId
    )
    const previousManagedCredentialsJson = previousAccount
      ? await this.readManagedCredentials(previousAccount)
      : null
    const previousManagedOauthAccount = previousAccount
      ? this.readManagedOauthAccount(previousAccount)
      : null
    if (previousAccount && previousAccount.id !== activeAccount?.id) {
      if (previousManagedCredentialsJson) {
        await this.readBackRefreshedTokens(previousManagedCredentialsJson, {
          updateLastWrittenCredentialsJson: true
        })
      }
    }
    if (!activeAccount) {
      if (settings.activeClaudeManagedAccountId) {
        this.store.updateSettings({ activeClaudeManagedAccountId: null })
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

    // Why: Claude CLI refreshes expired OAuth tokens and writes them back to
    // .credentials.json. If we detect the runtime file differs from what Orca
    // last wrote, the CLI must have refreshed — so we preserve those tokens
    // back to managed storage before overwriting runtime with managed state.
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
            // Why: this Claude process was launched under the active managed
            // account, but persistence still needs positive account proof.
            await this.writeManagedCredentials(activeAccount, readBackResult.runtimeCredentialsJson)
            credentialsJson = readBackResult.runtimeCredentialsJson
          } else {
            // Why: while Claude is running, an unknown refresh can still belong
            // to a live session. Rewriting stale managed auth logs that session out.
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
    const paths = this.pathResolver.getRuntimePaths()
    this.writeRuntimeCredentials(credentialsJson)
    if (process.platform === 'darwin') {
      // Why: Claude Code 2.1+ reads the scoped service, while older builds read
      // the legacy unsuffixed service. Runtime switching must satisfy both.
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

  // Why: called by ClaudeAccountService before syncForCurrentSelection() after
  // re-auth or add-account. Those flows write fresh tokens to managed storage,
  // so the read-back must be skipped to avoid overwriting them with stale
  // runtime tokens.
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
          : candidates.filter((candidate) => candidate !== this.lastWrittenCredentialsJson)
      if (changedCandidates.length === 0) {
        return { status: 'unchanged' }
      }

      const acceptedCandidates: {
        credentialsJson: string
        match: Extract<ClaudeReadBackMatch, { kind: 'matched' }>
      }[] = []
      const ambiguousCandidates: string[] = []
      let sawAmbiguousCandidate = false
      for (const runtimeContents of changedCandidates) {
        if (!this.isValidCredentialsJsonObject(runtimeContents)) {
          continue
        }
        const match = await this.findManagedAccountForRuntimeCredentials(runtimeContents)
        if (match.kind === 'ambiguous') {
          sawAmbiguousCandidate = true
          ambiguousCandidates.push(runtimeContents)
          continue
        }
        if (match.kind !== 'matched') {
          continue
        }
        // Why: on cold app start we cannot tell whether matching runtime
        // credentials are a fresh CLI refresh or stale state unless token
        // metadata proves runtime is newer than managed storage.
        if (this.lastWrittenCredentialsJson === null) {
          if (!this.runtimeCredentialsAreFresher(runtimeContents, match.managedCredentialsJson)) {
            continue
          }
        } else if (this.runtimeCredentialsAreOlder(runtimeContents, match.managedCredentialsJson)) {
          continue
        }
        acceptedCandidates.push({ credentialsJson: runtimeContents, match })
      }
      if (acceptedCandidates.length === 0) {
        if (sawAmbiguousCandidate) {
          console.warn('[claude-runtime-auth] Refusing ambiguous Claude auth read-back')
        }
        return {
          status: 'rejected',
          runtimeCredentialsChanged: true,
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
      // Why: read-back is best-effort. A transient fs error must not block the
      // forward sync path — the worst case is one more stale-token cycle, which
      // is strictly better than failing the entire sync.
      console.warn('[claude-runtime-auth] Failed to read back refreshed tokens:', error)
      return {
        status: 'rejected',
        runtimeCredentialsChanged:
          this.runtimeCredentialsChangedSinceLastWrite(baselineCredentialsJson)
      }
    }
  }

  private async readRuntimeCredentialCandidatesForReadBack(
    baselineCredentialsJson: string
  ): Promise<string[]> {
    const paths = this.pathResolver.getRuntimePaths()
    const fileCredentials = existsSync(paths.credentialsPath)
      ? readFileSync(paths.credentialsPath, 'utf-8')
      : null
    const candidates: string[] = []
    const pushCandidate = (credentialsJson: string | null): void => {
      if (credentialsJson && !candidates.includes(credentialsJson)) {
        candidates.push(credentialsJson)
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
        return candidates.filter((candidate) => candidate !== baselineCredentialsJson)
      }
      pushCandidate(scopedKeychainCredentials)
      pushCandidate(legacyKeychainCredentials)
    }
    pushCandidate(fileCredentials)
    return candidates
  }

  private getPreparation(): ClaudeRuntimeAuthPreparation {
    const settings = this.store.getSettings()
    const paths = this.pathResolver.getRuntimePaths()
    const activeAccountId = settings.activeClaudeManagedAccountId
    return {
      configDir: paths.configDir,
      envPatch: paths.envPatch,
      stripAuthEnv: Boolean(activeAccountId),
      provenance: activeAccountId ? `managed:${activeAccountId}` : 'system'
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

  private async findManagedAccountForRuntimeCredentials(
    runtimeCredentialsJson: string
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

    // Why: this mirrors the Codex runtime-home guard. If another Claude login
    // or missed live process rewrites shared runtime credentials, do not
    // persist those credentials into the selected managed account.
    const selectedOrganizationUuid = this.normalizeField(
      account.organizationUuid ??
        managedIdentity?.organizationUuid ??
        managedOauthIdentity.organizationUuid
    )
    if (!identity.email) {
      return 'unverifiable'
    }
    if (account.email && this.normalizeField(account.email) !== identity.email) {
      return 'mismatch'
    }
    if (selectedOrganizationUuid && !identity.organizationUuid) {
      return 'unverifiable'
    }
    if (
      selectedOrganizationUuid &&
      identity.organizationUuid &&
      selectedOrganizationUuid !== identity.organizationUuid
    ) {
      return 'mismatch'
    }
    if (!selectedOrganizationUuid && identity.organizationUuid) {
      return 'unverifiable'
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
    const selectedOrganizationUuid = this.normalizeField(
      account.organizationUuid ??
        managedIdentity?.organizationUuid ??
        managedOauthIdentity.organizationUuid
    )
    return (
      match === 'unverifiable' &&
      Boolean(selectedOrganizationUuid) &&
      identity?.organizationUuid === selectedOrganizationUuid
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

  private readIdentityFromOauthAccount(oauthAccount: unknown): ClaudeAuthIdentity {
    const oauth = this.asRecord(oauthAccount)
    return {
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
    // Why: runtime auth restore is two-phase: prove ownership before mutating
    // any surface, then restore OAuth first. If OAuth fails, the credential
    // proof remains intact for retry.
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
    // Why: persisted managed metadata is an account identity hint, not proof
    // that Orca wrote .claude.json. Use it only after another surface proves
    // the current runtime auth still belongs to the managed account.
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
    // Why: repeated Claude spawns sync auth, but credentials rarely change.
    // Skipping unchanged rewrites avoids Windows EPERM contention in #1507.
    // Still verify the file because another Claude process may have rewritten
    // runtime credentials since Orca last materialized them.
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
      // Why: invalid config is an unknown external state. Replacing it with a
      // fresh object could silently erase user or Claude-owned settings.
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
