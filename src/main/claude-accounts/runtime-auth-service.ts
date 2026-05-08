/* eslint-disable max-lines -- Why: Claude account switching has one safety
boundary: runtime auth materialization. Keeping file, Keychain, snapshot, and
env-patch semantics together prevents PTY launch and quota fetch paths drifting. */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
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

export class ClaudeRuntimeAuthService {
  private readonly pathResolver = new ClaudeRuntimePathResolver()
  private mutationQueue: Promise<unknown> = Promise.resolve()
  private lastSyncedAccountId: string | null = null
  // Why: tracks the credentials Orca last wrote to the shared credentials file.
  // On managed→system-default transition, if the file differs from this value,
  // an external login (e.g. `claude auth login`) overwrote it — so Orca adopts
  // the file as the new system default instead of restoring a stale snapshot.
  private lastWrittenCredentialsJson: string | null = null

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
        await this.restoreSystemDefaultSnapshot()
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
    if (!activeAccount) {
      if (this.lastSyncedAccountId !== null) {
        await this.restoreSystemDefaultSnapshot()
        this.lastSyncedAccountId = null
      }
      return
    }

    await this.captureSystemDefaultSnapshotIfNeeded()

    const credentialsJson = await this.readManagedCredentials(activeAccount)
    if (!credentialsJson) {
      console.warn(
        '[claude-runtime-auth] Active managed account is missing credentials, restoring system default'
      )
      this.store.updateSettings({ activeClaudeManagedAccountId: null })
      if (this.lastSyncedAccountId !== null) {
        await this.restoreSystemDefaultSnapshot()
        this.lastSyncedAccountId = null
      }
      return
    }

    // Why: Claude CLI refreshes expired OAuth tokens and writes them back to
    // .credentials.json. If we detect the runtime file differs from what Orca
    // last wrote, the CLI must have refreshed — so we preserve those tokens
    // back to managed storage before overwriting runtime with managed state.
    if (this.lastSyncedAccountId === activeAccount.id) {
      await this.readBackRefreshedTokens(activeAccount)
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
  clearLastWrittenCredentialsJson(): void {
    this.lastWrittenCredentialsJson = null
  }

  private async readBackRefreshedTokens(account: ClaudeManagedAccount): Promise<void> {
    try {
      if (this.lastWrittenCredentialsJson === null) {
        return
      }

      const paths = this.pathResolver.getRuntimePaths()
      if (!existsSync(paths.credentialsPath)) {
        return
      }

      const runtimeContents = readFileSync(paths.credentialsPath, 'utf-8')
      if (runtimeContents === this.lastWrittenCredentialsJson) {
        return
      }

      if (process.platform === 'darwin') {
        await writeManagedClaudeKeychainCredentials(account.id, runtimeContents)
      } else {
        const credentialsPath = join(account.managedAuthPath, '.credentials.json')
        writeFileAtomically(credentialsPath, runtimeContents, { mode: 0o600 })
      }
    } catch (error) {
      // Why: read-back is best-effort. A transient fs error must not block the
      // forward sync path — the worst case is one more stale-token cycle, which
      // is strictly better than failing the entire sync.
      console.warn('[claude-runtime-auth] Failed to read back refreshed tokens:', error)
    }
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

  private async captureSystemDefaultSnapshotIfNeeded(): Promise<void> {
    const snapshotPath = this.getSystemDefaultSnapshotPath()
    if (existsSync(snapshotPath)) {
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

  private async restoreSystemDefaultSnapshot(): Promise<void> {
    if (this.detectExternalLoginAndUpdateSnapshot()) {
      return
    }

    const snapshotPath = this.getSystemDefaultSnapshotPath()
    if (!existsSync(snapshotPath)) {
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
      await (snapshot.keychainCredentialsJson !== null
        ? writeActiveClaudeKeychainCredentials(snapshot.keychainCredentialsJson)
        : deleteActiveClaudeKeychainCredentials())
    }
  }

  // Why: detects whether an external tool (e.g. `claude auth login`) overwrote
  // the credentials file while a managed account was active. If the file
  // differs from what Orca last wrote, that external login becomes the new
  // system default — no manual "refresh" button needed.
  private detectExternalLoginAndUpdateSnapshot(): boolean {
    if (this.lastWrittenCredentialsJson === null) {
      return false
    }
    const paths = this.pathResolver.getRuntimePaths()
    if (!existsSync(paths.credentialsPath)) {
      return false
    }
    const currentCredentials = readFileSync(paths.credentialsPath, 'utf-8')
    if (currentCredentials === this.lastWrittenCredentialsJson) {
      return false
    }
    // External login detected — adopt current state as the new system default
    const snapshotPath = this.getSystemDefaultSnapshotPath()
    rmSync(snapshotPath, { force: true })
    this.lastWrittenCredentialsJson = null
    return true
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
    if (this.lastWrittenCredentialsJson === contents && existsSync(credentialsPath)) {
      return
    }
    if (this.fileContentsEqual(credentialsPath, contents)) {
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
