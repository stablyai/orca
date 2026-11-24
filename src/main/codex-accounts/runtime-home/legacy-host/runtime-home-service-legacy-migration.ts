import {
  appendFileSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync
} from 'node:fs'
import { dirname, extname, join, parse, relative } from 'node:path'
import { writeFileAtomically } from '../../../filesystem/atomic-file-publication'
import { errnoCodeOrUnknown } from '../../../../shared/errors/errno-code'
import { migrateLegacySharedAuthToPerAccountHome } from './legacy-shared-auth-migration'
import { normalizeCodexRuntimeSelection } from '../../account-management/runtime-selection'
import { getSystemCodexHomePath } from '../../../codex/configuration/homes/codex-home-paths'
import { CodexRuntimeHomePaths } from '../runtime-home-service-paths'
import {
  legacySessionPassDue,
  parseLegacyHistoryState,
  recordLegacySessionPassFailure,
  settleLegacyHistoryImport,
  type LegacyHistoryState
} from './legacy-history-migration'

type LegacySessionConflict = { legacyFilePath: string; runtimeFilePath: string; accountId: string }

type LegacyMigrationMarker = { completedAt: number; migratedHomeCount: number }

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
    const historyStatePath = join(this.getRuntimeMetadataDir(), 'migration-v1-history.json')
    const migrated = existsSync(this.getMigrationMarkerPath())
    // Migrated by an older build, which merged the account histories itself.
    if (migrated && !existsSync(historyStatePath)) {
      return
    }
    let state: LegacyHistoryState = {}
    try {
      state = parseLegacyHistoryState(readFileSync(historyStatePath, 'utf-8'))
    } catch {
      // Absent or unreadable: nothing recorded yet.
    }
    try {
      if (!migrated && legacySessionPassDue(state)) {
        this.migrateLegacySessionsAndMarkDone(historyStatePath, state)
      }
    } finally {
      // Independent of the session copies, so one that fails can't hold the import back.
      void settleLegacyHistoryImport({
        accountsRoot: this.getManagedAccountsRoot(),
        runtimeHistoryPath: join(this.getRuntimeHomePath(), 'history.jsonl'),
        statePath: historyStatePath
      })
    }
  }

  /**
   * Copies the sessions, then keeps each one that conflicts with a runtime file beside it, then
   * marks the migration done. The conflict copies wait until every account's sessions copied: a
   * pass that fails adds none, so disk stays flat while a failure persists, and the pass that
   * succeeds keeps each conflict's latest bytes.
   */
  protected migrateLegacySessionsAndMarkDone(
    historyStatePath: string,
    state: LegacyHistoryState
  ): void {
    const managedHomes = this.getLegacyManagedHomes()
    try {
      const conflicts: LegacySessionConflict[] = []
      for (const managedHomePath of managedHomes) {
        const accountId = parse(relative(this.getManagedAccountsRoot(), managedHomePath)).dir.split(
          /[\\/]/
        )[0]
        if (accountId) {
          this.migrateLegacySessions(managedHomePath, accountId, conflicts)
        }
      }
      this.preserveLegacySessionConflicts(conflicts)
    } catch (error) {
      this.writeMigrationRecord(historyStatePath, recordLegacySessionPassFailure(state))
      throw error
    }
    // Present from here on: later launches owe the import until it settles.
    this.writeMigrationRecord(historyStatePath, state)
    this.writeMigrationRecord(this.getMigrationMarkerPath(), {
      completedAt: Date.now(),
      migratedHomeCount: managedHomes.length
    })
  }

  protected writeMigrationRecord(
    path: string,
    record: LegacyHistoryState | LegacyMigrationMarker
  ): void {
    writeFileAtomically(path, `${JSON.stringify(record)}\n`)
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

  // Copies each session into a free runtime name; one whose name holds other bytes is collected.
  protected migrateLegacySessions(
    managedHomePath: string,
    accountId: string,
    conflicts: LegacySessionConflict[] = []
  ): void {
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
      let legacyContents: Buffer | null = null
      const readLegacy = (): Buffer => (legacyContents ??= readFileSync(legacyFilePath))
      if (
        this.copyLegacyFileWithoutOverwrite(legacyFilePath, runtimeFilePath, readLegacy) ===
        'conflict'
      ) {
        conflicts.push({ legacyFilePath, runtimeFilePath, accountId })
      }
    }
  }

  // All or none: a failure removes the copies this pass made, so failing passes never pile copies
  // up. Codex never writes these names, and each was created exclusively by this pass.
  protected preserveLegacySessionConflicts(conflicts: readonly LegacySessionConflict[]): void {
    const created: { conflict: LegacySessionConflict; path: string }[] = []
    try {
      for (const conflict of conflicts) {
        const preserved = this.preserveLegacySessionConflict(conflict)
        if (preserved.copied) {
          created.push({ conflict, path: preserved.path })
        }
      }
    } catch (error) {
      for (const { path } of created) {
        rmSync(path, { force: true })
      }
      throw error
    }
    for (const { conflict, path } of created) {
      this.appendMigrationDiagnostic({
        type: 'session-conflict',
        accountId: conflict.accountId,
        runtimeFilePath: conflict.runtimeFilePath,
        preservedPath: path
      })
    }
  }

  // Copies beside the runtime file under the next free preserved name, or stops at one already
  // holding these bytes. Never replaces or writes through a name.
  protected preserveLegacySessionConflict(conflict: LegacySessionConflict): {
    path: string
    copied: boolean
  } {
    const { legacyFilePath, runtimeFilePath, accountId } = conflict
    let legacyContents: Buffer | null = null
    const readLegacy = (): Buffer => (legacyContents ??= readFileSync(legacyFilePath))
    for (let attempt = 0; ; attempt++) {
      const path = this.getPreservedLegacySessionPath(runtimeFilePath, accountId, attempt)
      const result = this.copyLegacyFileWithoutOverwrite(legacyFilePath, path, readLegacy)
      if (result !== 'conflict') {
        return { path, copied: result === 'copied' }
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
      // A link there is not a copy of its own, whatever it reaches.
      return lstatSync(targetPath).isFile() && readFileSync(targetPath).equals(legacyContents)
        ? 'identical'
        : 'conflict'
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
