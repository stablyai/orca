import { appendFileSync, existsSync, opendirSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomically } from './fs-utils'
import {
  mergeCodexLegacyHistorySync,
  type CodexLegacyHistoryMigrationLimits
} from './legacy-history-migration'
import {
  migrateCodexLegacySessionsSync,
  type CodexLegacySessionMigrationLimits
} from './legacy-session-migration'

export const CODEX_LEGACY_MANAGED_ACCOUNT_MAX_ENTRIES = 4096
export const CODEX_LEGACY_MANAGED_HOME_MAX_COUNT = 256
export const CODEX_LEGACY_MIGRATION_DIAGNOSTIC_MAX_RECORDS = 2048
export const CODEX_LEGACY_MIGRATION_DIAGNOSTIC_MAX_BYTES = 1024 * 1024

type LegacyManagedHome = {
  accountId: string
  homePath: string
}

type ManagedHomeDiscoveryResult =
  | { kind: 'complete'; homes: LegacyManagedHome[] }
  | {
      kind: 'skipped'
      reason: 'account-entries' | 'managed-homes'
      observed: number
      limit: number
    }

type MigrationDiagnostic = Record<string, boolean | number | string>

export type CodexLegacyManagedStateMigrationLimits = {
  maxAccountEntries: number
  maxManagedHomes: number
  maxDiagnosticRecords: number
  maxDiagnosticBytes: number
  history?: Partial<CodexLegacyHistoryMigrationLimits>
  sessions?: Partial<CodexLegacySessionMigrationLimits>
}

export type CodexLegacyManagedStateMigrationSummary = {
  diagnosticRecordsOmitted: number
  diagnosticRecordsWritten: number
  historySkippedHomeCount: number
  managedHomeDiscoverySkipped: boolean
  migratedHomeCount: number
  sessionSkippedHomeCount: number
}

const DEFAULT_LIMITS: CodexLegacyManagedStateMigrationLimits = {
  maxAccountEntries: CODEX_LEGACY_MANAGED_ACCOUNT_MAX_ENTRIES,
  maxManagedHomes: CODEX_LEGACY_MANAGED_HOME_MAX_COUNT,
  maxDiagnosticRecords: CODEX_LEGACY_MIGRATION_DIAGNOSTIC_MAX_RECORDS,
  maxDiagnosticBytes: CODEX_LEGACY_MIGRATION_DIAGNOSTIC_MAX_BYTES
}

export function migrateLegacyManagedCodexStateSync(options: {
  managedAccountsRoot: string
  metadataDir: string
  runtimeHomePath: string
  limits?: Partial<CodexLegacyManagedStateMigrationLimits>
}): CodexLegacyManagedStateMigrationSummary | null {
  const markerPath = join(options.metadataDir, 'migration-v1.json')
  if (existsSync(markerPath)) {
    return null
  }

  const limits = resolveLimits(options.limits)
  const diagnostics = new MigrationDiagnosticWriter(
    join(options.metadataDir, 'migration-diagnostics.jsonl'),
    limits.maxDiagnosticRecords,
    limits.maxDiagnosticBytes
  )
  const discovery = discoverLegacyManagedHomesSync(options.managedAccountsRoot, limits)
  let historySkippedHomeCount = 0
  let sessionSkippedHomeCount = 0

  if (discovery.kind === 'skipped') {
    diagnostics.append({
      type: 'managed-home-discovery-skipped',
      reason: discovery.reason,
      observed: discovery.observed,
      limit: discovery.limit
    })
  } else {
    for (const home of discovery.homes) {
      const legacyHistoryPath = join(home.homePath, 'history.jsonl')
      if (existsSync(legacyHistoryPath)) {
        const historyResult = mergeCodexLegacyHistorySync({
          legacyHistoryPath,
          runtimeHistoryPath: join(options.runtimeHomePath, 'history.jsonl'),
          limits: limits.history
        })
        if (historyResult.kind === 'skipped') {
          historySkippedHomeCount += 1
          diagnostics.append({
            type: 'history-skipped',
            accountId: home.accountId,
            legacyHistoryPath,
            reason: historyResult.reason,
            observed: historyResult.observed,
            limit: historyResult.limit
          })
        }
      }

      const legacySessionsRoot = join(home.homePath, 'sessions')
      if (!existsSync(legacySessionsRoot)) {
        continue
      }
      const sessionResult = migrateCodexLegacySessionsSync({
        accountId: home.accountId,
        legacySessionsRoot,
        runtimeSessionsRoot: join(options.runtimeHomePath, 'sessions'),
        limits: limits.sessions,
        onConflict: ({ runtimeFilePath, preservedPath }) => {
          diagnostics.append({
            type: 'session-conflict',
            accountId: home.accountId,
            runtimeFilePath,
            preservedPath
          })
        }
      })
      if (sessionResult.kind === 'skipped') {
        sessionSkippedHomeCount += 1
        diagnostics.append({
          type: 'sessions-skipped',
          accountId: home.accountId,
          legacySessionsRoot,
          reason: sessionResult.reason,
          observed: sessionResult.observed,
          limit: sessionResult.limit
        })
      }
    }
  }

  const summary: CodexLegacyManagedStateMigrationSummary = {
    diagnosticRecordsOmitted: diagnostics.omittedCount,
    diagnosticRecordsWritten: diagnostics.writtenCount,
    historySkippedHomeCount,
    managedHomeDiscoverySkipped: discovery.kind === 'skipped',
    migratedHomeCount: discovery.kind === 'complete' ? discovery.homes.length : 0,
    sessionSkippedHomeCount
  }
  writeMigrationMarker(markerPath, summary)
  warnAboutCapacitySkips(summary, markerPath)
  return summary
}

function discoverLegacyManagedHomesSync(
  managedAccountsRoot: string,
  limits: CodexLegacyManagedStateMigrationLimits
): ManagedHomeDiscoveryResult {
  if (!existsSync(managedAccountsRoot)) {
    return { kind: 'complete', homes: [] }
  }

  const homes: LegacyManagedHome[] = []
  let entryCount = 0
  const directory = opendirSync(managedAccountsRoot)
  try {
    while (true) {
      const entry = directory.readSync()
      if (entry === null) {
        break
      }
      entryCount += 1
      if (entryCount > limits.maxAccountEntries) {
        return {
          kind: 'skipped',
          reason: 'account-entries',
          observed: entryCount,
          limit: limits.maxAccountEntries
        }
      }
      if (!entry.isDirectory()) {
        continue
      }
      const homePath = join(managedAccountsRoot, entry.name, 'home')
      if (!existsSync(join(homePath, '.orca-managed-home'))) {
        continue
      }
      homes.push({ accountId: entry.name, homePath })
      if (homes.length > limits.maxManagedHomes) {
        return {
          kind: 'skipped',
          reason: 'managed-homes',
          observed: homes.length,
          limit: limits.maxManagedHomes
        }
      }
    }
  } finally {
    closeDirectoryIgnoringAlreadyClosed(directory)
  }
  return {
    kind: 'complete',
    homes: homes.sort(compareManagedHomePaths)
  }
}

function compareManagedHomePaths(left: LegacyManagedHome, right: LegacyManagedHome): number {
  if (left.homePath < right.homePath) {
    return -1
  }
  return left.homePath > right.homePath ? 1 : 0
}

function writeMigrationMarker(
  markerPath: string,
  summary: CodexLegacyManagedStateMigrationSummary
): void {
  const capacityDetails = {
    ...(summary.managedHomeDiscoverySkipped ? { managedHomeDiscoverySkipped: true } : {}),
    ...(summary.historySkippedHomeCount > 0
      ? { historySkippedHomeCount: summary.historySkippedHomeCount }
      : {}),
    ...(summary.sessionSkippedHomeCount > 0
      ? { sessionSkippedHomeCount: summary.sessionSkippedHomeCount }
      : {}),
    ...(summary.diagnosticRecordsOmitted > 0
      ? { diagnosticRecordsOmitted: summary.diagnosticRecordsOmitted }
      : {})
  }
  writeFileAtomically(
    markerPath,
    `${JSON.stringify({
      completedAt: Date.now(),
      migratedHomeCount: summary.migratedHomeCount,
      ...capacityDetails
    })}\n`
  )
}

function warnAboutCapacitySkips(
  summary: CodexLegacyManagedStateMigrationSummary,
  markerPath: string
): void {
  const skippedCount =
    Number(summary.managedHomeDiscoverySkipped) +
    summary.historySkippedHomeCount +
    summary.sessionSkippedHomeCount
  if (skippedCount === 0 && summary.diagnosticRecordsOmitted === 0) {
    return
  }
  console.warn('[codex-runtime-home] Legacy state migration completed with bounded skips:', {
    skippedCount,
    diagnosticRecordsOmitted: summary.diagnosticRecordsOmitted,
    markerPath
  })
}

class MigrationDiagnosticWriter {
  private bytesWritten = 0
  private failed = false
  omittedCount = 0
  writtenCount = 0

  constructor(
    private readonly path: string,
    private readonly maxRecords: number,
    private readonly maxBytes: number
  ) {}

  append(record: MigrationDiagnostic): void {
    const line = `${JSON.stringify(record)}\n`
    const lineBytes = Buffer.byteLength(line)
    if (
      this.failed ||
      this.writtenCount >= this.maxRecords ||
      lineBytes > this.maxBytes - this.bytesWritten
    ) {
      this.omittedCount += 1
      return
    }
    try {
      appendFileSync(this.path, line, { encoding: 'utf8' })
      this.writtenCount += 1
      this.bytesWritten += lineBytes
    } catch (error) {
      this.failed = true
      this.omittedCount += 1
      console.warn('[codex-runtime-home] Failed to append migration diagnostic:', error)
    }
  }
}

function resolveLimits(
  overrides: Partial<CodexLegacyManagedStateMigrationLimits> | undefined
): CodexLegacyManagedStateMigrationLimits {
  const limits = { ...DEFAULT_LIMITS, ...overrides }
  for (const [name, value] of Object.entries({
    maxAccountEntries: limits.maxAccountEntries,
    maxManagedHomes: limits.maxManagedHomes,
    maxDiagnosticRecords: limits.maxDiagnosticRecords,
    maxDiagnosticBytes: limits.maxDiagnosticBytes
  })) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative safe integer`)
    }
  }
  return limits
}

function closeDirectoryIgnoringAlreadyClosed(directory: ReturnType<typeof opendirSync>): void {
  try {
    directory.closeSync()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ERR_DIR_CLOSED') {
      throw error
    }
  }
}
