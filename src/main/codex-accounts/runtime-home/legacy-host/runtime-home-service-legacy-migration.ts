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
  publishLegacyHistoryIfAbsent,
  trackLegacyHistoryImport,
  type LegacyHistoryImportOutcome
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
    if (existsSync(this.getMigrationMarkerPath())) {
      return
    }

    const managedHomes: { accountId: string; homePath: string }[] = []
    for (const homePath of this.getLegacyManagedHomes()) {
      const accountId = parse(relative(this.getManagedAccountsRoot(), homePath)).dir.split(
        /[\\/]/
      )[0]
      if (accountId) {
        managedHomes.push({ accountId, homePath })
      }
    }
    // First and synchronously: nothing later (a failed session copy, an account removed while the
    // import runs) may leave a legacy history without a copy Orca keeps.
    const keptHistoryPaths = this.keepLegacyHistoriesAside(managedHomes)
    for (const { accountId, homePath } of managedHomes) {
      this.migrateLegacySessions(homePath, accountId)
    }
    void this.finishLegacyManagedStateMigration(keptHistoryPaths, managedHomes.length)
  }

  // History reads and writes stay off the startup path: a large history takes tens of milliseconds.
  protected async finishLegacyManagedStateMigration(
    keptHistoryPaths: string[],
    migratedHomeCount: number
  ): Promise<void> {
    try {
      await this.migrateLegacyHistory(keptHistoryPaths)
      // Mark completion so later startups cannot replay stale managed-home state.
      writeFileAtomically(
        this.getMigrationMarkerPath(),
        `${JSON.stringify({ completedAt: Date.now(), migratedHomeCount })}\n`
      )
    } catch (error) {
      console.warn('[codex-runtime-home] Failed to migrate legacy managed Codex state:', error)
    }
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

  /** Copies each account's legacy history under Orca's metadata, which no removal or cleanup reaches. */
  protected keepLegacyHistoriesAside(
    managedHomes: { accountId: string; homePath: string }[]
  ): string[] {
    const keptRoot = join(this.getRuntimeMetadataDir(), 'legacy-account-history')
    const keptPaths: string[] = []
    let firstError: unknown = null
    for (const { accountId, homePath } of managedHomes) {
      const legacyHistoryPath = join(homePath, 'history.jsonl')
      if (!existsSync(legacyHistoryPath)) {
        continue
      }
      try {
        mkdirSync(join(keptRoot, accountId), { recursive: true })
        const kept = this.copyLegacyFilePreservingConflicts(
          legacyHistoryPath,
          join(keptRoot, accountId, 'history.jsonl'),
          accountId
        )
        keptPaths.push(kept.path)
      } catch (error) {
        firstError ??= error
      }
    }
    if (firstError) {
      throw firstError
    }
    return keptPaths
  }

  /**
   * Codex may be appending to or trimming a shared history.jsonl that exists, so only a missing one
   * is created from the kept copies, and never over one Codex creates meanwhile.
   */
  protected async migrateLegacyHistory(keptHistoryPaths: string[]): Promise<void> {
    if (keptHistoryPaths.length === 0) {
      return
    }
    let outcome: LegacyHistoryImportOutcome
    try {
      outcome = await publishLegacyHistoryIfAbsent(
        keptHistoryPaths,
        join(this.getRuntimeHomePath(), 'history.jsonl')
      )
    } catch (error) {
      console.warn('[codex-runtime-home] Failed to import legacy Codex prompt history:', error)
      outcome = 'failed'
    }
    trackLegacyHistoryImport(outcome)
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
    if (this.copyLegacyFileWithoutOverwrite(legacyFilePath, targetPath) !== 'conflict') {
      return { path: targetPath, preserved: false }
    }
    for (let attempt = 0; ; attempt++) {
      const preservedPath = this.getPreservedLegacySessionPath(targetPath, accountId, attempt)
      const result = this.copyLegacyFileWithoutOverwrite(legacyFilePath, preservedPath)
      if (result !== 'conflict') {
        return { path: preservedPath, preserved: result === 'copied' }
      }
    }
  }

  /** Exclusive create never replaces or writes through a name, even one that appears after a check. */
  protected copyLegacyFileWithoutOverwrite(
    legacyFilePath: string,
    targetPath: string
  ): 'copied' | 'identical' | 'conflict' {
    try {
      copyFileSync(legacyFilePath, targetPath, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
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
