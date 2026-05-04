/* eslint-disable max-lines -- Why: this service owns the single runtime-home
contract for Codex inside Orca. Keeping path resolution, system-default
snapshots, auth materialization, and recovery together prevents account-switch
semantics from drifting across PTY launch, login, and quota fetch paths. */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, extname, join, parse, relative } from 'node:path'
import { app } from 'electron'
import type { CodexManagedAccount } from '../../shared/types'
import type { Store } from '../persistence'
import { writeFileAtomically } from './fs-utils'

export class CodexRuntimeHomeService {
  // Why: tracks whether auth.json is currently managed by Orca. When null,
  // Orca does NOT own auth.json and must not overwrite external changes
  // (e.g. user running `codex login` or another auth tool). The snapshot
  // restore only fires on the managed→system-default transition.
  private lastSyncedAccountId: string | null = null
  // Why: tracks the auth.json content Orca last wrote to ~/.codex/auth.json.
  // Between syncs, if the file differs, Codex CLI refreshed the token — so
  // Orca writes back the refreshed token to managed storage before overwriting.
  // On managed→system-default transition, if the file differs, an external
  // login (e.g. `codex auth login`) overwrote it — so Orca adopts the file as
  // the new system default instead of restoring a stale snapshot.
  private lastWrittenAuthJson: string | null = null

  constructor(private readonly store: Store) {
    this.safeMigrateLegacyManagedState()
    this.initializeLastSyncedState()
    this.safeSyncForCurrentSelection()
  }

  private initializeLastSyncedState(): void {
    const settings = this.store.getSettings()
    this.lastSyncedAccountId = settings.activeCodexManagedAccountId
  }

  prepareForCodexLaunch(): string {
    this.safeSyncForCurrentSelection()
    return this.getRuntimeHomePath()
  }

  prepareForRateLimitFetch(): string {
    this.safeSyncForCurrentSelection()
    return this.getRuntimeHomePath()
  }

  syncForCurrentSelection(): void {
    this.captureSystemDefaultSnapshotIfNeeded()

    const settings = this.store.getSettings()
    const activeAccount = this.getActiveAccount(
      settings.codexManagedAccounts,
      settings.activeCodexManagedAccountId
    )
    if (!activeAccount) {
      // Why: only restore the snapshot when transitioning FROM a managed
      // account back to system default. When no managed account was ever
      // active, auth.json belongs to the user and Orca must not touch it.
      // This prevents overwriting external auth changes (codex login or other
      // tools) on every PTY launch / rate-limit fetch.
      if (this.lastSyncedAccountId !== null) {
        this.restoreSystemDefaultSnapshot()
        this.lastSyncedAccountId = null
      }
      return
    }

    const activeAuthPath = join(activeAccount.managedHomePath, 'auth.json')
    if (!existsSync(activeAuthPath)) {
      console.warn(
        '[codex-runtime-home] Active managed account is missing auth.json, restoring system default'
      )
      this.store.updateSettings({ activeCodexManagedAccountId: null })
      if (this.lastSyncedAccountId !== null) {
        this.restoreSystemDefaultSnapshot()
        this.lastSyncedAccountId = null
      }
      return
    }

    // Why: Codex CLI refreshes expired OAuth tokens and writes them back to
    // ~/.codex/auth.json. If we detect the runtime file differs from what Orca
    // last wrote, the CLI must have refreshed — so we preserve those tokens
    // back to managed storage before overwriting runtime with managed state.
    if (this.lastSyncedAccountId === activeAccount.id) {
      this.readBackRefreshedTokens(activeAuthPath)
    }

    this.lastSyncedAccountId = activeAccount.id
    this.writeRuntimeAuth(readFileSync(activeAuthPath, 'utf-8'))
  }

  // Why: called by CodexAccountService before syncForCurrentSelection() after
  // re-auth or add-account. Those flows write fresh tokens to managed storage,
  // so the read-back must be skipped to avoid overwriting them with stale
  // runtime tokens.
  clearLastWrittenAuthJson(): void {
    this.lastWrittenAuthJson = null
  }

  private readBackRefreshedTokens(managedAuthPath: string): void {
    try {
      const runtimeAuthPath = this.getRuntimeAuthPath()
      if (!existsSync(runtimeAuthPath)) {
        return
      }

      if (this.lastWrittenAuthJson === null) {
        return
      }

      const runtimeContents = readFileSync(runtimeAuthPath, 'utf-8')
      if (runtimeContents === this.lastWrittenAuthJson) {
        return
      }

      writeFileAtomically(managedAuthPath, runtimeContents, { mode: 0o600 })
    } catch (error) {
      // Why: read-back is best-effort. A transient fs error must not block the
      // forward sync path — the worst case is one more stale-token cycle, which
      // is strictly better than failing the entire sync.
      console.warn('[codex-runtime-home] Failed to read back refreshed tokens:', error)
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

  private safeMigrateLegacyManagedState(): void {
    try {
      this.migrateLegacyManagedStateIfNeeded()
    } catch (error) {
      console.warn('[codex-runtime-home] Failed to migrate legacy managed Codex state:', error)
    }
  }

  private getRuntimeHomePath(): string {
    const runtimeHomePath = join(homedir(), '.codex')
    mkdirSync(runtimeHomePath, { recursive: true })
    return runtimeHomePath
  }

  private getRuntimeAuthPath(): string {
    return join(this.getRuntimeHomePath(), 'auth.json')
  }

  private getSystemDefaultSnapshotPath(): string {
    return join(this.getRuntimeMetadataDir(), 'system-default-auth.json')
  }

  private getRuntimeMetadataDir(): string {
    const metadataDir = join(app.getPath('userData'), 'codex-runtime-home')
    mkdirSync(metadataDir, { recursive: true })
    return metadataDir
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
    // would keep replaying stale managed-home state back into ~/.codex and
    // make the shared runtime feel nondeterministic.
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
        files.push(...this.listFilesRecursively(childPath))
        continue
      }
      if (entry.isFile()) {
        files.push(childPath)
      }
    }
    return files.sort()
  }

  private getPreservedLegacySessionPath(runtimeFilePath: string, accountId: string): string {
    const extension = extname(runtimeFilePath)
    const basename = runtimeFilePath.slice(0, runtimeFilePath.length - extension.length)
    return `${basename}.orca-legacy-${accountId}${extension}`
  }

  private appendMigrationDiagnostic(record: Record<string, string>): void {
    const diagnosticsPath = this.getMigrationDiagnosticsPath()
    const existingContents = existsSync(diagnosticsPath)
      ? readFileSync(diagnosticsPath, 'utf-8')
      : ''
    writeFileAtomically(diagnosticsPath, `${existingContents}${JSON.stringify(record)}\n`)
  }

  private captureSystemDefaultSnapshotIfNeeded(): void {
    const snapshotPath = this.getSystemDefaultSnapshotPath()
    if (existsSync(snapshotPath)) {
      return
    }

    const runtimeAuthPath = this.getRuntimeAuthPath()
    if (!existsSync(runtimeAuthPath)) {
      return
    }

    writeFileAtomically(snapshotPath, readFileSync(runtimeAuthPath, 'utf-8'))
  }

  private restoreSystemDefaultSnapshot(): void {
    // Why: detect whether an external tool (e.g. `codex auth login`) overwrote
    // auth.json while a managed account was active. If so, that external login
    // becomes the new system default — skip the stale snapshot restore.
    if (this.detectExternalLoginAndUpdateSnapshot()) {
      return
    }

    const snapshotPath = this.getSystemDefaultSnapshotPath()
    if (!existsSync(snapshotPath)) {
      return
    }

    this.writeRuntimeAuth(readFileSync(snapshotPath, 'utf-8'))
  }

  // Why: mirrors ClaudeRuntimeAuthService.detectExternalLoginAndUpdateSnapshot().
  // If the runtime auth.json differs from what Orca last wrote, something
  // external changed it. That external state should become the new system
  // default rather than being overwritten by a potentially stale snapshot.
  private detectExternalLoginAndUpdateSnapshot(): boolean {
    if (this.lastWrittenAuthJson === null) {
      return false
    }

    const runtimeAuthPath = this.getRuntimeAuthPath()
    if (!existsSync(runtimeAuthPath)) {
      return false
    }

    try {
      const currentAuth = readFileSync(runtimeAuthPath, 'utf-8')
      if (currentAuth === this.lastWrittenAuthJson) {
        return false
      }
    } catch {
      return false
    }

    const snapshotPath = this.getSystemDefaultSnapshotPath()
    rmSync(snapshotPath, { force: true })
    this.lastWrittenAuthJson = null
    return true
  }

  private writeRuntimeAuth(contents: string): void {
    // Why: auth.json contains sensitive credentials. Restrict to owner-only
    // so other users on a shared Linux/macOS machine cannot read it.
    writeFileAtomically(this.getRuntimeAuthPath(), contents, { mode: 0o600 })
    this.lastWrittenAuthJson = contents
  }

  clearSystemDefaultSnapshot(): void {
    rmSync(this.getSystemDefaultSnapshotPath(), { force: true })
  }
}
