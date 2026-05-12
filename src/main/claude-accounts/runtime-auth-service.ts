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
import { ClaudeRuntimePathResolver } from './runtime-paths'
import {
  deleteActiveClaudeKeychainCredentials,
  readActiveClaudeKeychainCredentials,
  readManagedClaudeKeychainCredentials,
  writeActiveClaudeKeychainCredentials,
  writeManagedClaudeKeychainCredentials
} from './keychain'

export type ClaudeRuntimeAuthPreparation = {
  envPatch: ClaudeEnvPatch
  stripAuthEnv: boolean
  provenance: string
}

type ClaudeSystemDefaultSnapshot = {
  credentialsJson: string | null
  configOauthAccount: unknown
  keychainCredentialsJson: string | null
  capturedAt: number
}

type ClaudeAuthIdentity = {
  email: string | null
  organizationUuid: string | null
}

type ClaudeReadBackResult = { status: 'unchanged' | 'persisted' | 'rejected' }
type ClaudeReadBackMatch =
  | { kind: 'matched'; account: ClaudeManagedAccount }
  | { kind: 'none' | 'ambiguous' }

export class ClaudeRuntimeAuthService {
  private readonly pathResolver = new ClaudeRuntimePathResolver()
  private mutationQueue: Promise<unknown> = Promise.resolve()
  private lastSyncedAccountId: string | null = null
  // Why: tracks the credentials Orca last wrote to the shared credentials file.
  // On managed→system-default transition, if the file differs from this value,
  // an external login (e.g. `claude auth login`) overwrote it — so Orca adopts
  // the file as the new system default instead of restoring a stale snapshot.
  private lastWrittenCredentialsJson: string | null = null
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
        await this.restoreSystemDefaultSnapshot({ detectExternalLogin: true })
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
    let outgoingReadBackResult: ClaudeReadBackResult = { status: 'unchanged' }
    if (previousAccount && previousAccount.id !== activeAccount?.id) {
      outgoingReadBackResult = await this.readBackRefreshedTokensForAccount(previousAccount, {
        updateLastWrittenCredentialsJson: true
      })
    }
    if (!activeAccount) {
      if (settings.activeClaudeManagedAccountId) {
        this.store.updateSettings({ activeClaudeManagedAccountId: null })
      }
      if (this.lastSyncedAccountId !== null) {
        await this.restoreSystemDefaultSnapshot({
          detectExternalLogin: outgoingReadBackResult.status !== 'rejected'
        })
        this.lastSyncedAccountId = null
      }
      return
    }

    let credentialsJson = await this.readManagedCredentials(activeAccount)
    if (!credentialsJson) {
      console.warn(
        '[claude-runtime-auth] Active managed account is missing credentials, restoring system default'
      )
      this.store.updateSettings({ activeClaudeManagedAccountId: null })
      if (this.lastSyncedAccountId !== null) {
        await this.restoreSystemDefaultSnapshot({ detectExternalLogin: true })
        this.lastSyncedAccountId = null
      }
      return
    }

    if (this.lastSyncedAccountId === null) {
      await this.captureSystemDefaultSnapshot({ force: true })
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
          credentialsJson = (await this.readManagedCredentials(activeAccount)) ?? credentialsJson
        }
      }
    }

    if (this.lastSyncedAccountId !== activeAccount.id) {
      this.skipNextReadBackForAccountId = null
    }
    this.writeRuntimeCredentials(credentialsJson)
    if (process.platform === 'darwin') {
      await writeActiveClaudeKeychainCredentials(credentialsJson)
    }
    this.writeRuntimeOauthAccount(this.readManagedOauthAccount(activeAccount))
    this.lastSyncedAccountId = activeAccount.id
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
      const runtimeContents = await this.readRuntimeCredentialsForReadBack(baselineCredentialsJson)
      if (!runtimeContents) {
        return { status: 'unchanged' }
      }
      if (
        this.lastWrittenCredentialsJson !== null &&
        runtimeContents === this.lastWrittenCredentialsJson
      ) {
        return { status: 'unchanged' }
      }

      const match = await this.findManagedAccountForRuntimeCredentials(runtimeContents)
      if (match.kind !== 'matched') {
        if (match.kind === 'ambiguous') {
          console.warn('[claude-runtime-auth] Refusing ambiguous Claude auth read-back')
        }
        return { status: 'rejected' }
      }
      // Why: on cold app start we cannot tell whether matching runtime
      // credentials are a fresh CLI refresh or stale state unless token
      // metadata proves runtime is newer than managed storage.
      if (
        this.lastWrittenCredentialsJson === null &&
        !this.runtimeCredentialsAreFresher(runtimeContents, baselineCredentialsJson)
      ) {
        return { status: 'rejected' }
      }

      await this.writeManagedCredentials(match.account, runtimeContents)
      if (options.updateLastWrittenCredentialsJson) {
        this.writeRuntimeCredentials(runtimeContents)
        this.lastWrittenCredentialsJson = runtimeContents
        if (process.platform === 'darwin') {
          await writeActiveClaudeKeychainCredentials(runtimeContents)
        }
      }
      return { status: 'persisted' }
    } catch (error) {
      // Why: read-back is best-effort. A transient fs error must not block the
      // forward sync path — the worst case is one more stale-token cycle, which
      // is strictly better than failing the entire sync.
      console.warn('[claude-runtime-auth] Failed to read back refreshed tokens:', error)
      return { status: 'rejected' }
    }
  }

  private async readRuntimeCredentialsForReadBack(
    baselineCredentialsJson: string
  ): Promise<string | null> {
    const paths = this.pathResolver.getRuntimePaths()
    const fileCredentials = existsSync(paths.credentialsPath)
      ? readFileSync(paths.credentialsPath, 'utf-8')
      : null
    if (process.platform === 'darwin') {
      const keychainCredentials = await readActiveClaudeKeychainCredentials()
      if (this.lastWrittenCredentialsJson === null) {
        if (keychainCredentials && keychainCredentials !== baselineCredentialsJson) {
          return keychainCredentials
        }
        if (fileCredentials && fileCredentials !== baselineCredentialsJson) {
          return fileCredentials
        }
        return keychainCredentials ?? fileCredentials
      }
      if (keychainCredentials && keychainCredentials !== this.lastWrittenCredentialsJson) {
        return keychainCredentials
      }
    }
    if (!fileCredentials) {
      return null
    }
    return fileCredentials
  }

  private async readBackRefreshedTokensForAccount(
    account: ClaudeManagedAccount,
    options: { updateLastWrittenCredentialsJson: boolean }
  ): Promise<ClaudeReadBackResult> {
    const managedCredentialsJson = await this.readManagedCredentials(account)
    if (!managedCredentialsJson) {
      return { status: 'unchanged' }
    }
    return this.readBackRefreshedTokens(managedCredentialsJson, options)
  }

  private getPreparation(): ClaudeRuntimeAuthPreparation {
    const settings = this.store.getSettings()
    const paths = this.pathResolver.getRuntimePaths()
    const activeAccountId = settings.activeClaudeManagedAccountId
    return {
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
    const matches: ClaudeManagedAccount[] = []
    for (const account of this.store.getSettings().claudeManagedAccounts) {
      const managedCredentialsJson = await this.readManagedCredentials(account)
      if (!managedCredentialsJson) {
        continue
      }
      if (
        this.runtimeCredentialsMatchAccount(
          runtimeCredentialsJson,
          account,
          managedCredentialsJson,
          this.readManagedOauthAccount(account)
        ) === 'match'
      ) {
        matches.push(account)
      }
    }

    if (matches.length === 1) {
      return { kind: 'matched', account: matches[0] }
    }
    return { kind: matches.length === 0 ? 'none' : 'ambiguous' }
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
    if (!identity.email) {
      return 'unverifiable'
    }
    if (account.email && identity.email && this.normalizeField(account.email) !== identity.email) {
      return 'mismatch'
    }

    return 'match'
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
    if (process.platform === 'darwin') {
      return readManagedClaudeKeychainCredentials(account.id)
    }
    const credentialsPath = join(account.managedAuthPath, '.credentials.json')
    if (!existsSync(credentialsPath)) {
      return null
    }
    return readFileSync(credentialsPath, 'utf-8')
  }

  private async writeManagedCredentials(
    account: ClaudeManagedAccount,
    credentialsJson: string
  ): Promise<void> {
    if (process.platform === 'darwin') {
      await writeManagedClaudeKeychainCredentials(account.id, credentialsJson)
      return
    }
    const credentialsPath = join(account.managedAuthPath, '.credentials.json')
    writeFileAtomically(credentialsPath, credentialsJson, { mode: 0o600 })
  }

  private readManagedOauthAccount(account: ClaudeManagedAccount): unknown {
    const oauthPath = join(account.managedAuthPath, 'oauth-account.json')
    if (!existsSync(oauthPath)) {
      return null
    }
    try {
      return JSON.parse(readFileSync(oauthPath, 'utf-8')) as unknown
    } catch {
      return null
    }
  }

  private async captureSystemDefaultSnapshot(options: { force: boolean }): Promise<void> {
    const snapshotPath = this.getSystemDefaultSnapshotPath()
    if (!options.force && existsSync(snapshotPath)) {
      return
    }

    const paths = this.pathResolver.getRuntimePaths()
    const credentialsJson = existsSync(paths.credentialsPath)
      ? readFileSync(paths.credentialsPath, 'utf-8')
      : null
    const keychainCredentialsJson = await readActiveClaudeKeychainCredentials()
    const snapshot: ClaudeSystemDefaultSnapshot = {
      credentialsJson,
      configOauthAccount: this.readRuntimeOauthAccount(),
      keychainCredentialsJson,
      capturedAt: Date.now()
    }
    this.writeJson(snapshotPath, snapshot)
  }

  private async restoreSystemDefaultSnapshot(options: {
    detectExternalLogin: boolean
  }): Promise<void> {
    const externalState = options.detectExternalLogin
      ? await this.detectExternalLoginAndUpdateSnapshot()
      : 'none'
    if (externalState === 'file-logout') {
      return
    }

    const snapshotPath = this.getSystemDefaultSnapshotPath()
    if (!existsSync(snapshotPath)) {
      rmSync(this.pathResolver.getRuntimePaths().credentialsPath, { force: true })
      if (process.platform === 'darwin') {
        await deleteActiveClaudeKeychainCredentials()
      }
      this.lastWrittenCredentialsJson = null
      return
    }
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf-8')) as ClaudeSystemDefaultSnapshot
    if (snapshot.credentialsJson !== null) {
      this.writeRuntimeCredentials(snapshot.credentialsJson)
    } else {
      rmSync(this.pathResolver.getRuntimePaths().credentialsPath, { force: true })
    }
    this.writeRuntimeOauthAccount(snapshot.configOauthAccount)
    if (process.platform === 'darwin') {
      if (externalState !== 'keychain-change') {
        await (snapshot.keychainCredentialsJson !== null
          ? writeActiveClaudeKeychainCredentials(snapshot.keychainCredentialsJson)
          : deleteActiveClaudeKeychainCredentials())
      }
    }
  }

  // Why: detects whether an external tool (e.g. `claude auth login`) overwrote
  // the credentials file while a managed account was active. If the file
  // differs from what Orca last wrote, that external login becomes the new
  // system default — no manual "refresh" button needed.
  private async detectExternalLoginAndUpdateSnapshot(): Promise<
    'none' | 'file-logout' | 'keychain-change'
  > {
    if (this.lastWrittenCredentialsJson === null) {
      return 'none'
    }
    const paths = this.pathResolver.getRuntimePaths()
    if (!existsSync(paths.credentialsPath)) {
      const currentKeychainCredentials =
        process.platform === 'darwin' ? await readActiveClaudeKeychainCredentials() : null
      if (
        process.platform === 'darwin' &&
        currentKeychainCredentials === this.lastWrittenCredentialsJson
      ) {
        return 'none'
      }
      const snapshotPath = this.getSystemDefaultSnapshotPath()
      rmSync(snapshotPath, { force: true })
      this.lastWrittenCredentialsJson = null
      return 'file-logout'
    }
    const currentCredentials = readFileSync(paths.credentialsPath, 'utf-8')
    const currentKeychainCredentials =
      process.platform === 'darwin' ? await readActiveClaudeKeychainCredentials() : null
    if (currentCredentials === this.lastWrittenCredentialsJson) {
      if (
        process.platform === 'darwin' &&
        currentKeychainCredentials !== this.lastWrittenCredentialsJson
      ) {
        return 'keychain-change'
      }
      return 'none'
    }
    const snapshotPath = this.getSystemDefaultSnapshotPath()
    rmSync(snapshotPath, { force: true })
    this.lastWrittenCredentialsJson = null
    return 'file-logout'
  }

  private readRuntimeOauthAccount(): unknown {
    const configPath = this.pathResolver.getRuntimePaths().configPath
    if (!existsSync(configPath)) {
      return null
    }
    try {
      const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>
      return parsed.oauthAccount ?? null
    } catch {
      return null
    }
  }

  private writeRuntimeOauthAccount(oauthAccount: unknown): void {
    const configPath = this.pathResolver.getRuntimePaths().configPath
    const existing = this.readJsonObject(configPath)
    if (oauthAccount === null || oauthAccount === undefined) {
      delete existing.oauthAccount
    } else {
      existing.oauthAccount = oauthAccount
    }
    this.writeJson(configPath, existing)
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

  private readJsonObject(targetPath: string): Record<string, unknown> {
    if (!existsSync(targetPath)) {
      return {}
    }
    try {
      const parsed = JSON.parse(readFileSync(targetPath, 'utf-8')) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      /* Preserve no invalid JSON; Claude can recreate unsupported config files. */
    }
    return {}
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
