import {
  appendFileSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync
} from 'node:fs'
import { dirname, extname, join, parse, relative } from 'node:path'
import { writeFileAtomically } from '../../../filesystem/atomic-file-publication'
import { errnoCodeOrUnknown } from '../../../../shared/errors/errno-code'
import { migrateLegacySharedAuthToPerAccountHome } from './legacy-shared-auth-migration'
import { normalizeCodexRuntimeSelection } from '../../account-management/runtime-selection'
import { getSystemCodexHomePath } from '../../../codex/configuration/homes/codex-home-paths'
import { CodexRuntimeHomePaths } from '../runtime-home-service-paths'
import { settleLegacyHistory } from './legacy-history-migration'

export abstract class CodexRuntimeHomeLegacyMigration extends CodexRuntimeHomePaths {
  protected safeMigrateLegacySharedAuth(): void {
    const settings = this.store.getSettings()
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
      // Leave completion unmarked on inconclusive results so the next startup can retry.
      console.warn('[codex-runtime-home] Failed to migrate legacy shared Codex auth:', error)
    }
  }

  protected safeMigrateLegacyManagedState(): void {
    try {
      this.migrateLegacyManagedStateIfNeeded()
    } catch (error) {
      console.warn('[codex-runtime-home] Failed to migrate legacy managed Codex state:', error)
    }
  }

  protected safeMigrateLegacyActiveHomePointer(): void {
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

  protected migrateLegacyManagedStateIfNeeded(): void {
    const sessionsDone = existsSync(this.getSessionsMigratedStatePath())
    // Migrated by an older build.
    if (!sessionsDone && existsSync(this.getMigrationMarkerPath())) {
      return
    }

    void settleLegacyHistory(
      {
        accountsRoot: this.getManagedAccountsRoot(),
        runtimeHistoryPath: join(this.getRuntimeHomePath(), 'history.jsonl'),
        statePath: join(this.getRuntimeMetadataDir(), 'migration-v1-history.json'),
        sessionsStatePath: this.getSessionsMigratedStatePath(),
        markerPath: this.getMigrationMarkerPath()
      },
      sessionsDone ? null : () => this.migrateLegacySessionsAndMarkDone()
    )
  }

  // Synchronous end to end, so no quit lands between the session copies and the marker older
  // builds read: without it they would rerun their overwriting migration.
  protected migrateLegacySessionsAndMarkDone(): void {
    const managedHomes = this.getLegacyManagedHomes()
    for (const managedHomePath of managedHomes) {
      const accountId = parse(relative(this.getManagedAccountsRoot(), managedHomePath)).dir.split(
        /[\\/]/
      )[0]
      if (accountId) {
        this.migrateLegacySessions(managedHomePath, accountId)
      }
    }
    const record = `${JSON.stringify({ completedAt: Date.now(), migratedHomeCount: managedHomes.length })}\n`
    writeFileAtomically(this.getSessionsMigratedStatePath(), record)
    writeFileAtomically(this.getMigrationMarkerPath(), record)
  }

  protected getSessionsMigratedStatePath(): string {
    return join(this.getRuntimeMetadataDir(), 'migration-v1-sessions.json')
  }

  protected getLegacyManagedHomes(): string[] {
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

  protected migrateLegacySessions(managedHomePath: string, accountId: string): void {
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
      const copy = this.copyLegacyFilePreservingConflicts(
        legacyFilePath,
        runtimeFilePath,
        accountId
      )
      if (copy.preserved) {
        this.appendMigrationDiagnostic({
          type: 'session-conflict',
          accountId,
          runtimeFilePath,
          preservedPath: copy.path
        })
      }
    }
  }

  /**
   * Copies to `targetPath` unless it already holds these bytes; when it holds others, copies beside
   * it under the next free preserved name. Returns where the legacy bytes now are.
   */
  protected copyLegacyFilePreservingConflicts(
    legacyFilePath: string,
    targetPath: string,
    accountId: string
  ): { path: string; preserved: boolean } {
    let legacyContents: Buffer | null = null
    const readLegacy = (): Buffer => (legacyContents ??= readFileSync(legacyFilePath))
    if (
      this.copyLegacyFileWithoutOverwrite(legacyFilePath, targetPath, readLegacy) !== 'conflict'
    ) {
      return { path: targetPath, preserved: false }
    }
    for (let attempt = 0; ; attempt++) {
      const preservedPath = this.getPreservedLegacySessionPath(targetPath, accountId, attempt)
      const result = this.copyLegacyFileWithoutOverwrite(legacyFilePath, preservedPath, readLegacy)
      if (result !== 'conflict') {
        return { path: preservedPath, preserved: result === 'copied' }
      }
    }
  }

  /** Exclusive create never replaces or writes through a name, even one that appears after a check. */
  protected copyLegacyFileWithoutOverwrite(
    legacyFilePath: string,
    targetPath: string,
    readLegacy: () => Buffer
  ): 'copied' | 'identical' | 'conflict' {
    try {
      copyFileSync(legacyFilePath, targetPath, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
      return 'copied'
    } catch (error) {
      if (errnoCodeOrUnknown(error) !== 'EEXIST') {
        throw error
      }
    }
    const legacyContents = readLegacy()
    try {
      return readFileSync(targetPath).equals(legacyContents) ? 'identical' : 'conflict'
    } catch {
      // A dangling link or directory at this name still occupies it.
      return 'conflict'
    }
  }

  protected listFilesRecursively(rootPath: string): string[] {
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

  protected appendListedFiles(target: string[], source: readonly string[]): void {
    // Avoid V8's argument limit for directories too large to append with spread.
    for (const filePath of source) {
      target.push(filePath)
    }
  }

  protected getPreservedLegacySessionPath(
    runtimeFilePath: string,
    accountId: string,
    attempt: number
  ): string {
    const extension = extname(runtimeFilePath)
    const basename = runtimeFilePath.slice(0, runtimeFilePath.length - extension.length)
    const suffix = attempt === 0 ? '' : `-${attempt}`
    return `${basename}.orca-legacy-${accountId}${suffix}${extension}`
  }

  protected appendMigrationDiagnostic(record: Record<string, string>): void {
    const diagnosticsPath = this.getMigrationDiagnosticsPath()
    try {
      appendFileSync(diagnosticsPath, `${JSON.stringify(record)}\n`, { encoding: 'utf-8' })
    } catch (error) {
      // Diagnostic failures must not abort migration after the session has been preserved.
      console.warn('[codex-runtime-home] Failed to append migration diagnostic:', error)
    }
  }
}
