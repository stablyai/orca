import {
  appendFileSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync
} from 'node:fs'
import { basename, dirname, extname, join, relative } from 'node:path'
import { writeFileAtomically } from '../../../filesystem/atomic-file-publication'
import { errnoCodeOrUnknown } from '../../../../shared/errors/errno-code'
import { migrateLegacySharedAuthToPerAccountHome } from './legacy-shared-auth-migration'
import { normalizeCodexRuntimeSelection } from '../../account-management/runtime-selection'
import { getSystemCodexHomePath } from '../../../codex/configuration/homes/codex-home-paths'
import { CodexRuntimeHomePaths } from '../runtime-home-service-paths'
import {
  parseLegacyHistoryState,
  settleLegacyHistoryImport,
  type LegacyHistoryState
} from './legacy-history-migration'

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
    try {
      let state: LegacyHistoryState = {}
      try {
        state = parseLegacyHistoryState(readFileSync(historyStatePath, 'utf-8'))
      } catch {
        // Absent or unreadable: copies already made are found again as identical files.
      }
      if (!migrated || state.sessionsPending) {
        this.migrateLegacyManagedState(historyStatePath, state, migrated)
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
   * One synchronous step at startup, before anything can remove or share an account: every account
   * history gets its copy, then the sessions are copied, then the marker older builds read is
   * written. No quit lands between them. An older build never sees the marker while an account
   * history has no copy (its account removal would take the only one), and never sees copied
   * sessions without it (it would rerun its overwriting migration). A session that fails to copy
   * stays in its account home, which every build's removal keeps, and is retried on later launches.
   */
  protected migrateLegacyManagedState(
    historyStatePath: string,
    state: LegacyHistoryState,
    migrated: boolean
  ): void {
    const managedHomes = this.getLegacyManagedHomes()
    if (!migrated) {
      const preserved = new Set(state.preservedAccounts)
      this.preserveLegacyHistories(managedHomes, preserved, (accountId) => {
        preserved.add(accountId)
        state = { ...state, preservedAccounts: [...preserved] }
        this.writeMigrationRecord(historyStatePath, state)
      })
    }
    let sessionsPending = false
    for (const managedHomePath of managedHomes) {
      try {
        this.migrateLegacySessions(managedHomePath, basename(dirname(managedHomePath)))
      } catch (error) {
        sessionsPending = true
        console.warn('[codex-runtime-home] Failed to migrate legacy Codex sessions:', error)
      }
    }
    // Present from here on: later launches owe the import until it settles.
    this.writeMigrationRecord(historyStatePath, { ...state, sessionsPending })
    this.writeMigrationRecord(this.getMigrationMarkerPath(), {
      completedAt: Date.now(),
      migratedHomeCount: managedHomes.length
    })
  }

  // Each account's own history, copied into the runtime home, where no Orca path deletes it. A
  // folder Orca doesn't own can't be removed through Orca, so one that fails is skipped.
  protected preserveLegacyHistories(
    managedHomes: readonly string[],
    alreadyPreserved: ReadonlySet<string>,
    recordPreserved: (accountId: string) => void
  ): void {
    const managedAccounts = new Set(managedHomes.map((home) => basename(dirname(home))))
    const runtimeHistoryPath = join(this.getRuntimeHomePath(), 'history.jsonl')
    mkdirSync(this.getRuntimeHomePath(), { recursive: true })
    // An account history that is the shared history itself needs no copy; one it links to does.
    const sharedHistory = this.legacyHistorySource(runtimeHistoryPath, { followLink: false })
    const copiedSources = new Set<string>()
    for (const accountId of this.listLegacyAccountIds()) {
      if (alreadyPreserved.has(accountId)) {
        continue
      }
      try {
        const historyPath = join(this.getManagedAccountsRoot(), accountId, 'home', 'history.jsonl')
        const source = this.legacyHistorySource(historyPath, { followLink: true })
        if (!source) {
          continue
        }
        if (source !== sharedHistory && !copiedSources.has(source)) {
          this.copyLegacyFilePreservingConflicts(source, runtimeHistoryPath, accountId, true)
          copiedSources.add(source)
        }
        recordPreserved(accountId)
      } catch (error) {
        if (managedAccounts.has(accountId)) {
          throw error
        }
        console.warn('[codex-runtime-home] Skipped an unowned legacy Codex history:', error)
      }
    }
  }

  // Every account folder, ownership marker or not, sorted.
  protected listLegacyAccountIds(): string[] {
    try {
      return readdirSync(this.getManagedAccountsRoot(), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
    } catch (error) {
      if (errnoCodeOrUnknown(error) === 'ENOENT') {
        return []
      }
      throw error
    }
  }

  // The real path of a regular history file, or null when there is none (or, without followLink,
  // when the name is a link).
  protected legacyHistorySource(path: string, options: { followLink: boolean }): string | null {
    try {
      if (!options.followLink && !lstatSync(path).isFile()) {
        return null
      }
      const source = realpathSync(path)
      return statSync(source).isFile() ? source : null
    } catch (error) {
      const code = errnoCodeOrUnknown(error)
      // A link loop holds no history either.
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') {
        return null
      }
      throw error
    }
  }

  protected writeMigrationRecord(
    path: string,
    record: LegacyHistoryState | LegacyMigrationMarker
  ): void {
    writeFileAtomically(path, `${JSON.stringify(record)}\n`)
  }

  protected getLegacyManagedHomes(): string[] {
    return this.listLegacyAccountIds()
      .map((accountId) => join(this.getManagedAccountsRoot(), accountId, 'home'))
      .filter((managedHomePath) => existsSync(join(managedHomePath, '.orca-managed-home')))
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
   * Copies to `targetPath` unless it already holds these bytes; when it holds others (or with
   * preservedNameOnly), copies beside it under the next free preserved name. Returns where the
   * legacy bytes now are.
   */
  protected copyLegacyFilePreservingConflicts(
    legacyFilePath: string,
    targetPath: string,
    accountId: string,
    preservedNameOnly = false
  ): { path: string; preserved: boolean } {
    let legacyContents: Buffer | null = null
    const readLegacy = (): Buffer => (legacyContents ??= readFileSync(legacyFilePath))
    if (
      !preservedNameOnly &&
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
