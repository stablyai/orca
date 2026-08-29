import { createHash, randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { streamCodexSessionLedgerRecords } from './codex-session-ledger-stream'
import type { CodexSessionBackfillSummary } from './codex-session-backfill-types'

export type CodexSessionBackfillAuditWriter = (record: Record<string, unknown>) => Promise<boolean>

export type CodexSessionBackfillAuditCoverage = {
  fileEventIds: Set<string>
  diagnosticEventIds: Set<string>
  hasRunSummary: boolean
}

const HEAL_AUDIT_ACTIONS = new Set(['hardlink', 'copy', 'existing'])
const DIAGNOSTIC_AUDIT_ACTIONS = new Set(['copy-unsupported', 'failed'])

export function createCodexSessionBackfillAuditWriter(
  auditLogPath: string
): CodexSessionBackfillAuditWriter {
  let auditDirectoryReady: Promise<string | undefined> | undefined
  const appendRecord = async (serializedRecord: string): Promise<void> => {
    auditDirectoryReady ??= mkdir(dirname(auditLogPath), { recursive: true }).catch(
      (error: unknown) => {
        auditDirectoryReady = undefined
        throw error
      }
    )
    await auditDirectoryReady
    await appendFile(auditLogPath, serializedRecord, { encoding: 'utf-8' })
  }
  return async (record): Promise<boolean> => {
    // Why: a crash can leave a partial final JSON object. A leading newline
    // quarantines that torn tail so this recovery record remains parseable.
    const serializedRecord = `\n${JSON.stringify({
      at: new Date().toISOString(),
      ...record,
      // Why: a later managed-lane pass can recreate the same thread id, so a
      // terminal heal outcome must identify this particular publication event.
      recordId: randomUUID()
    })}\n`
    try {
      await appendRecord(serializedRecord)
      return true
    } catch {
      // Why: the heal consumes this ledger as its work queue. Retry the same
      // record once so a transient mkdir/write failure cannot omit a session.
    }
    try {
      await appendRecord(serializedRecord)
      return true
    } catch (error) {
      // Why: a published hardlink/copy may already be in use, so persistent
      // ledger failure is reported but cannot safely roll back the backfill.
      console.warn('[codex-session-backfill] Failed to append audit record:', error)
      return false
    }
  }
}

export async function readCodexSessionBackfillAuditCoverage(
  auditLogPath: string
): Promise<CodexSessionBackfillAuditCoverage> {
  const coverage: CodexSessionBackfillAuditCoverage = {
    fileEventIds: new Set<string>(),
    diagnosticEventIds: new Set<string>(),
    hasRunSummary: false
  }
  for await (const record of streamCodexSessionLedgerRecords(auditLogPath, {
    throwOnReadFailure: true
  })) {
    coverage.hasRunSummary ||= record.action === 'run-summary'
    if (
      typeof record.action === 'string' &&
      HEAL_AUDIT_ACTIONS.has(record.action) &&
      typeof record.fileEventId === 'string'
    ) {
      coverage.fileEventIds.add(record.fileEventId)
    }
    if (
      typeof record.action === 'string' &&
      DIAGNOSTIC_AUDIT_ACTIONS.has(record.action) &&
      typeof record.diagnosticEventId === 'string'
    ) {
      coverage.diagnosticEventIds.add(record.diagnosticEventId)
    }
  }
  return coverage
}

export function createCodexSessionBackfillFileEventId(targetPath: string, stat: Stats): string {
  const fileIdentity = [
    stat.dev,
    stat.ino,
    stat.birthtimeMs,
    stat.size,
    stat.mtimeMs,
    stat.ctimeMs
  ].join('\0')
  return createHash('sha256')
    .update(normalizeRuntimePathForComparison(targetPath))
    .update('\0')
    .update(fileIdentity)
    .digest('hex')
}

export function createCodexSessionBackfillDiagnosticEventId(args: {
  action: 'copy-unsupported' | 'failed'
  source: string
  target: string
  sourceStat: Stats | null
  errorCode?: string
  linkErrorCode?: string
}): string {
  const sourceIdentity = args.sourceStat
    ? [
        args.sourceStat.dev,
        args.sourceStat.ino,
        args.sourceStat.birthtimeMs,
        args.sourceStat.size,
        args.sourceStat.mtimeMs,
        args.sourceStat.ctimeMs
      ].join('\0')
    : 'unavailable'
  return createHash('sha256')
    .update(args.action)
    .update('\0')
    .update(normalizeRuntimePathForComparison(args.source))
    .update('\0')
    .update(normalizeRuntimePathForComparison(args.target))
    .update('\0')
    .update(sourceIdentity)
    .update('\0')
    .update(args.errorCode ?? '')
    .update('\0')
    .update(args.linkErrorCode ?? '')
    .digest('hex')
}

export function describeCodexSessionBackfillErrorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' && code
    ? code
    : error instanceof Error
      ? error.name
      : typeof error
}

export async function appendCodexSessionHealAuditRecord(
  writer: CodexSessionBackfillAuditWriter,
  summary: CodexSessionBackfillSummary,
  record: Record<string, unknown>
): Promise<boolean> {
  const appended = await writer(record)
  if (!appended) {
    summary.failedHealAuditRecords += 1
  }
  return appended
}

export async function recordExistingCodexSessionForHeal(
  writer: CodexSessionBackfillAuditWriter,
  summary: CodexSessionBackfillSummary,
  source: string,
  target: string,
  fileEventId?: string
): Promise<boolean> {
  summary.skippedExistingFiles += 1
  // Why: this also recovers a rollout installed before a crash or audit
  // failure; thread/read is idempotent for a pre-existing real-home file.
  return appendCodexSessionHealAuditRecord(writer, summary, {
    action: 'existing',
    source,
    target,
    ...(fileEventId ? { fileEventId } : {})
  })
}
