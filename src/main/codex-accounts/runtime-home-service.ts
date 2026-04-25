/* eslint-disable max-lines -- Why: this service owns the single runtime-home
contract for Codex inside Orca. Keeping path resolution, system-default
snapshots, auth materialization, and recovery together prevents account-switch
semantics from drifting across PTY launch, login, and quota fetch paths. */
import { existsSync, mkdirSync } from 'node:fs'
import { promises as fs } from 'node:fs'
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

  constructor(private readonly store: Store) {
    this.initializeLastSyncedState()
    // Why: floating promises in constructor are handled via safe wrappers
    // with internal try/catch to avoid unhandled rejections.
    void this.safeMigrateLegacyManagedState()
    void this.safeSyncForCurrentSelection()
  }

  private initializeLastSyncedState(): void {
    const settings = this.store.getSettings()
    this.lastSyncedAccountId = settings.activeCodexManagedAccountId
  }

  prepareForCodexLaunch(): string {
    // Why: sync wrapper for PTY launch path. Trigger async sync in background;
    // PTY will read whatever is there.
    void this.safeSyncForCurrentSelection()
    return this.getRuntimeHomePath()
  }

  prepareForRateLimitFetch(): string {
    void this.safeSyncForCurrentSelection()
    return this.getRuntimeHomePath()
  }

  async syncForCurrentSelection(): Promise<void> {
    await this.captureSystemDefaultSnapshotIfNeeded()

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
        await this.restoreSystemDefaultSnapshot()
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
        await this.restoreSystemDefaultSnapshot()
        this.lastSyncedAccountId = null
      }
      return
    }

    this.lastSyncedAccountId = activeAccount.id
    const contents = await fs.readFile(activeAuthPath, 'utf-8')
    await this.writeRuntimeAuth(contents)
  }

  private async safeSyncForCurrentSelection(): Promise<void> {
    try {
      await this.syncForCurrentSelection()
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

  private async safeMigrateLegacyManagedState(): Promise<void> {
    try {
      await this.migrateLegacyManagedStateIfNeeded()
    } catch (error) {
      console.warn('[codex-runtime-home] Failed to migrate legacy managed Codex state:', error)
    }
  }

  private getRuntimeHomePath(): string {
    const runtimeHomePath = join(homedir(), '.codex')
    if (!existsSync(runtimeHomePath)) {
      mkdirSync(runtimeHomePath, { recursive: true })
    }
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
    if (!existsSync(metadataDir)) {
      mkdirSync(metadataDir, { recursive: true })
    }
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

  private async migrateLegacyManagedStateIfNeeded(): Promise<void> {
    if (existsSync(this.getMigrationMarkerPath())) {
      return
    }

    const managedHomes = await this.getLegacyManagedHomes()
    for (const managedHomePath of managedHomes) {
      const accountId = parse(relative(this.getManagedAccountsRoot(), managedHomePath)).dir.split(
        /[\\/]/
      )[0]
      if (!accountId) {
        continue
      }
      await this.migrateLegacyHistory(managedHomePath)
      await this.migrateLegacySessions(managedHomePath, accountId)
    }

    // Why: migration is intentionally one-shot. Re-importing every startup
    // would keep replaying stale managed-home state back into ~/.codex and
    // make the shared runtime feel nondeterministic.
    await writeFileAtomically(
      this.getMigrationMarkerPath(),
      `${JSON.stringify({ completedAt: Date.now(), migratedHomeCount: managedHomes.length })}\n`
    )
  }

  private async getLegacyManagedHomes(): Promise<string[]> {
    const managedAccountsRoot = this.getManagedAccountsRoot()
    if (!existsSync(managedAccountsRoot)) {
      return []
    }

    const accountEntries = await fs.readdir(managedAccountsRoot, { withFileTypes: true })
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

  private async migrateLegacyHistory(managedHomePath: string): Promise<void> {
    const legacyHistoryPath = join(managedHomePath, 'history.jsonl')
    if (!existsSync(legacyHistoryPath)) {
      return
    }

    const runtimeHistoryPath = join(this.getRuntimeHomePath(), 'history.jsonl')
    const existingLines = existsSync(runtimeHistoryPath)
      ? (await fs.readFile(runtimeHistoryPath, 'utf-8')).split('\n').filter(Boolean)
      : []
    const mergedLines = [...existingLines]
    const seenLines = new Set(existingLines)
    const legacyLines = (await fs.readFile(legacyHistoryPath, 'utf-8')).split('\n')
    for (const line of legacyLines) {
      if (!line || seenLines.has(line)) {
        continue
      }
      seenLines.add(line)
      mergedLines.push(line)
    }

    if (mergedLines.length === 0) {
      return
    }
    await writeFileAtomically(runtimeHistoryPath, `${mergedLines.join('\n')}\n`)
  }

  private async migrateLegacySessions(managedHomePath: string, accountId: string): Promise<void> {
    const legacySessionsRoot = join(managedHomePath, 'sessions')
    if (!existsSync(legacySessionsRoot)) {
      return
    }

    const runtimeSessionsRoot = join(this.getRuntimeHomePath(), 'sessions')
    await fs.mkdir(runtimeSessionsRoot, { recursive: true })
    const legacyFiles = await this.listFilesRecursively(legacySessionsRoot)
    for (const legacyFilePath of legacyFiles) {
      const relativePath = relative(legacySessionsRoot, legacyFilePath)
      const runtimeFilePath = join(runtimeSessionsRoot, relativePath)
      await fs.mkdir(dirname(runtimeFilePath), { recursive: true })

      if (!existsSync(runtimeFilePath)) {
        await fs.copyFile(legacyFilePath, runtimeFilePath)
        continue
      }

      const legacyContents = await fs.readFile(legacyFilePath)
      const runtimeContents = await fs.readFile(runtimeFilePath)
      if (runtimeContents.equals(legacyContents)) {
        continue
      }

      const preservedPath = this.getPreservedLegacySessionPath(runtimeFilePath, accountId)
      await fs.copyFile(legacyFilePath, preservedPath)
      await this.appendMigrationDiagnostic({
        type: 'session-conflict',
        accountId,
        runtimeFilePath,
        preservedPath
      })
    }
  }

  private async listFilesRecursively(rootPath: string): Promise<string[]> {
    const stat = await fs.stat(rootPath)
    if (!stat.isDirectory()) {
      return [rootPath]
    }

    const files: string[] = []
    const entries = await fs.readdir(rootPath, { withFileTypes: true })
    for (const entry of entries) {
      const childPath = join(rootPath, entry.name)
      if (entry.isDirectory()) {
        files.push(...(await this.listFilesRecursively(childPath)))
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

  private async appendMigrationDiagnostic(record: Record<string, string>): Promise<void> {
    const diagnosticsPath = this.getMigrationDiagnosticsPath()
    const existingContents = existsSync(diagnosticsPath)
      ? await fs.readFile(diagnosticsPath, 'utf-8')
      : ''
    await writeFileAtomically(diagnosticsPath, `${existingContents}${JSON.stringify(record)}\n`)
  }

  private async captureSystemDefaultSnapshotIfNeeded(): Promise<void> {
    const snapshotPath = this.getSystemDefaultSnapshotPath()
    if (existsSync(snapshotPath)) {
      return
    }

    const runtimeAuthPath = this.getRuntimeAuthPath()
    if (!existsSync(runtimeAuthPath)) {
      return
    }

    const contents = await fs.readFile(runtimeAuthPath, 'utf-8')
    await writeFileAtomically(snapshotPath, contents)
  }

  private async restoreSystemDefaultSnapshot(): Promise<void> {
    const snapshotPath = this.getSystemDefaultSnapshotPath()
    if (!existsSync(snapshotPath)) {
      return
    }

    const contents = await fs.readFile(snapshotPath, 'utf-8')
    await this.writeRuntimeAuth(contents)
  }

  private async writeRuntimeAuth(contents: string): Promise<void> {
    // Why: auth.json contains sensitive credentials. Restrict to owner-only
    // so other users on a shared Linux/macOS machine cannot read it.
    await writeFileAtomically(this.getRuntimeAuthPath(), contents, { mode: 0o600 })
  }

  async clearSystemDefaultSnapshot(): Promise<void> {
    await fs.rm(this.getSystemDefaultSnapshotPath(), { force: true }).catch(() => {})
  }
}
