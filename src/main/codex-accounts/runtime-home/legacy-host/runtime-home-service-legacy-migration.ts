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
import { nodeFileContentsEqualSync } from '../../../../shared/file-content/node-file-content-equality'
import { migrateLegacySharedAuthToPerAccountHome } from './legacy-shared-auth-migration'
import { normalizeCodexRuntimeSelection } from '../../account-management/runtime-selection'
import { getSystemCodexHomePath } from '../../../codex/configuration/homes/codex-home-paths'
import { CodexRuntimeHomePaths } from '../runtime-home-service-paths'
import {
  appendMissingLegacyHistory,
  importLegacyHistoryWhenNoCodexIsLive,
  type LegacyMigrationMarker
} from './legacy-prompt-history-import'

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
    const existingMarker = this.readMigrationMarker()
    if (existingMarker) {
      if (existingMarker.historyPending) {
        void this.importLegacyHistoryWhenNoCodexIsLive(existingMarker)
      }
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
      this.migrateLegacySessions(managedHomePath, accountId)
    }

    const historyPending = managedHomes.some((home) => existsSync(join(home, 'history.jsonl')))
    const marker: LegacyMigrationMarker = {
      completedAt: Date.now(),
      migratedHomeCount: managedHomes.length,
      ...(historyPending ? { historyPending } : {})
    }
    // Mark completion so later startups cannot replay stale managed-home state.
    this.writeMigrationMarker(marker)
    if (historyPending) {
      void this.importLegacyHistoryWhenNoCodexIsLive(marker)
    }
  }

  protected importLegacyHistoryWhenNoCodexIsLive(marker: LegacyMigrationMarker): Promise<void> {
    return importLegacyHistoryWhenNoCodexIsLive({
      runtimeHomePath: this.getRuntimeHomePath(),
      importHistory: () => {
        for (const managedHomePath of this.getLegacyManagedHomes()) {
          this.migrateLegacyHistory(managedHomePath)
        }
        const { historyPending: _imported, ...completed } = marker
        this.writeMigrationMarker(completed)
      }
    })
  }

  protected readMigrationMarker(): LegacyMigrationMarker | null {
    const markerPath = this.getMigrationMarkerPath()
    if (!existsSync(markerPath)) {
      return null
    }
    try {
      const parsed: unknown = JSON.parse(readFileSync(markerPath, 'utf-8'))
      return parsed && typeof parsed === 'object' ? (parsed as LegacyMigrationMarker) : {}
    } catch {
      // An unreadable marker still means the one-time migration ran.
      return {}
    }
  }

  protected writeMigrationMarker(marker: LegacyMigrationMarker): void {
    writeFileAtomically(this.getMigrationMarkerPath(), `${JSON.stringify(marker)}\n`)
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

  protected migrateLegacyHistory(managedHomePath: string): void {
    const legacyHistoryPath = join(managedHomePath, 'history.jsonl')
    if (existsSync(legacyHistoryPath)) {
      appendMissingLegacyHistory(
        legacyHistoryPath,
        join(this.getRuntimeHomePath(), 'history.jsonl')
      )
    }
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
      if (this.copyLegacyFileWithoutOverwrite(legacyFilePath, runtimeFilePath) !== 'conflict') {
        continue
      }

      for (let attempt = 0; ; attempt++) {
        const preservedPath = this.getPreservedLegacySessionPath(
          runtimeFilePath,
          accountId,
          attempt
        )
        const result = this.copyLegacyFileWithoutOverwrite(legacyFilePath, preservedPath)
        if (result === 'conflict') {
          continue
        }
        if (result === 'copied') {
          this.appendMigrationDiagnostic({
            type: 'session-conflict',
            accountId,
            runtimeFilePath,
            preservedPath
          })
        }
        break
      }
    }
  }

  /** Exclusive create never replaces or writes through a name, even one that appears after a check. */
  protected copyLegacyFileWithoutOverwrite(
    legacyFilePath: string,
    targetPath: string
  ): 'copied' | 'identical' | 'conflict' {
    try {
      copyFileSync(legacyFilePath, targetPath, constants.COPYFILE_EXCL)
      return 'copied'
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error
      }
    }
    const legacyContents = readFileSync(legacyFilePath)
    try {
      return nodeFileContentsEqualSync(targetPath, legacyContents) ? 'identical' : 'conflict'
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
