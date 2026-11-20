import {
  appendFileSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  type Dirent
} from 'node:fs'
import { dirname, extname, join, parse, relative } from 'node:path'
import { writeFileAtomically } from '../../../filesystem/atomic-file-publication'
import { errnoCodeOrUnknown } from '../../../../shared/errors/errno-code'
import { migrateLegacySharedAuthToPerAccountHome } from './legacy-shared-auth-migration'
import { normalizeCodexRuntimeSelection } from '../../account-management/runtime-selection'
import { getSystemCodexHomePath } from '../../../codex/configuration/homes/codex-home-paths'
import { CodexRuntimeHomePaths } from '../runtime-home-service-paths'
import {
  attemptLegacyHistoryImport,
  parseLegacyMigrationState,
  recordLegacyHistoryImport,
  retryLegacyHistoryImport,
  type LegacyHistoryImportTarget,
  type LegacyMigrationState
} from './legacy-history-import-attempts'

function realpathIfPresent(path: string): string | null {
  try {
    return realpathSync(path)
  } catch (error) {
    const code = errnoCodeOrUnknown(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return null
    }
    throw error
  }
}

function byName(a: Dirent, b: Dirent): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

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
    const migrated = this.readSessionsMigratedState()
    if (migrated) {
      this.writeMigrationMarkerIfAbsent(migrated)
      if (!migrated.historyImportSettled) {
        void retryLegacyHistoryImport(this.legacyHistoryImportTarget(), migrated)
      }
      return
    }
    // Migrated by an older build.
    if (existsSync(this.getMigrationMarkerPath())) {
      return
    }

    // Started first and independent of the session copies, so one that fails can't hold it back.
    const historyImport = this.legacyHistoryImportTarget()
    const historyImported = attemptLegacyHistoryImport(historyImport)
    const managedHomes = this.getLegacyManagedHomes()
    for (const managedHomePath of managedHomes) {
      const accountId = parse(relative(this.getManagedAccountsRoot(), managedHomePath)).dir.split(
        /[\\/]/
      )[0]
      if (accountId) {
        this.migrateLegacySessions(managedHomePath, accountId)
      }
    }
    this.preserveLegacyHistories()

    // Recorded apart from the history import: one that keeps failing retries alone, never the
    // passes above.
    const state: LegacyMigrationState = {
      completedAt: Date.now(),
      migratedHomeCount: managedHomes.length
    }
    this.writeSessionsMigratedState(state)
    // Safe for an older build to see now: with every account history preserved, its account
    // removal can't take the only copy, and it must not rerun its overwriting migration.
    this.writeMigrationMarkerIfAbsent(state)
    void historyImported.then((imported) =>
      recordLegacyHistoryImport(historyImport, state, imported)
    )
  }

  // Every account's own history, kept in the runtime home where no Orca path deletes it.
  protected preserveLegacyHistories(): void {
    const runtimeHistoryPath = join(this.getRuntimeHomePath(), 'history.jsonl')
    const sharedHistory = realpathIfPresent(runtimeHistoryPath)
    const preserved = new Set<string>()
    const accountsRoot = this.getManagedAccountsRoot()
    const accounts = existsSync(accountsRoot)
      ? readdirSync(accountsRoot, { withFileTypes: true })
      : []
    for (const account of accounts.filter((entry) => entry.isDirectory()).sort(byName)) {
      const historyPath = join(accountsRoot, account.name, 'home', 'history.jsonl')
      const source = realpathIfPresent(historyPath)
      if (!source || source === sharedHistory || preserved.has(source)) {
        continue
      }
      if (!statSync(source).isFile()) {
        continue
      }
      preserved.add(source)
      let contents: Buffer | null = null
      const readLegacy = (): Buffer => (contents ??= readFileSync(source))
      this.copyToFreePreservedName(source, runtimeHistoryPath, account.name, readLegacy)
    }
  }

  protected writeMigrationMarkerIfAbsent(state: LegacyMigrationState): void {
    if (!existsSync(this.getMigrationMarkerPath())) {
      writeFileAtomically(
        this.getMigrationMarkerPath(),
        `${JSON.stringify({ completedAt: state.completedAt, migratedHomeCount: state.migratedHomeCount })}\n`
      )
    }
  }

  protected legacyHistoryImportTarget(): LegacyHistoryImportTarget {
    return {
      accountsRoot: this.getManagedAccountsRoot(),
      runtimeHistoryPath: join(this.getRuntimeHomePath(), 'history.jsonl'),
      writeState: (state) => this.writeSessionsMigratedState(state)
    }
  }

  protected getSessionsMigratedStatePath(): string {
    return join(this.getRuntimeMetadataDir(), 'migration-v1-sessions.json')
  }

  protected readSessionsMigratedState(): LegacyMigrationState | null {
    if (!existsSync(this.getSessionsMigratedStatePath())) {
      return null
    }
    try {
      return parseLegacyMigrationState(readFileSync(this.getSessionsMigratedStatePath(), 'utf-8'))
    } catch {
      // Unreadable: the sessions pass still ran; the history import retries from scratch.
      return {}
    }
  }

  protected writeSessionsMigratedState(state: LegacyMigrationState): void {
    writeFileAtomically(this.getSessionsMigratedStatePath(), `${JSON.stringify(state)}\n`)
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
    return this.copyToFreePreservedName(legacyFilePath, targetPath, accountId, readLegacy)
  }

  protected copyToFreePreservedName(
    legacyFilePath: string,
    targetPath: string,
    accountId: string,
    readLegacy: () => Buffer
  ): { path: string; preserved: boolean } {
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
