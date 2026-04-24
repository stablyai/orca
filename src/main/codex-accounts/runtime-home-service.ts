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

    this.lastSyncedAccountId = activeAccount.id
    this.writeRuntimeAuth(readFileSync(activeAuthPath, 'utf-8'))
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
    const snapshotPath = this.getSystemDefaultSnapshotPath()
    if (!existsSync(snapshotPath)) {
      return
    }

    this.writeRuntimeAuth(readFileSync(snapshotPath, 'utf-8'))
  }

  private writeRuntimeAuth(contents: string): void {
    // Why: auth.json contains sensitive credentials. Restrict to owner-only
    // so other users on a shared Linux/macOS machine cannot read it.
    writeFileAtomically(this.getRuntimeAuthPath(), contents, { mode: 0o600 })
  }

  clearSystemDefaultSnapshot(): void {
    rmSync(this.getSystemDefaultSnapshotPath(), { force: true })
  }
}
