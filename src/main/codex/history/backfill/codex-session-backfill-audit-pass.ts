import type { Stats } from 'node:fs'
import { lstat } from 'node:fs/promises'
import {
  appendCodexSessionHealAuditRecord,
  createCodexSessionBackfillAuditWriter,
  createCodexSessionBackfillDiagnosticEventId,
  createCodexSessionBackfillFileEventId,
  readCodexSessionBackfillAuditCoverage,
  recordExistingCodexSessionForHeal,
  type CodexSessionBackfillAuditWriter
} from './codex-session-backfill-audit'
import type { CodexSessionBackfillSummary } from './codex-session-backfill-types'

export type CodexSessionBackfillAuditPass = {
  appendRecord: CodexSessionBackfillAuditWriter
  recordExisting(
    summary: CodexSessionBackfillSummary,
    source: string,
    target: string,
    targetStat: Stats | null
  ): Promise<void>
  recordPublished(
    summary: CodexSessionBackfillSummary,
    action: 'hardlink' | 'copy',
    source: string,
    target: string
  ): Promise<void>
  recordDiagnostic(
    record: {
      action: 'copy-unsupported' | 'failed'
      source: string
      target: string
      error?: string
      linkError?: string
      errorCode?: string
      linkErrorCode?: string
    },
    sourceStat: Stats | null
  ): Promise<void>
  finish(summary: CodexSessionBackfillSummary): Promise<void>
}

export async function createCodexSessionBackfillAuditPass(
  auditLogPath: string
): Promise<CodexSessionBackfillAuditPass> {
  const coverage = await readCodexSessionBackfillAuditCoverage(auditLogPath)
  const writeAuditRecord = createCodexSessionBackfillAuditWriter(auditLogPath)
  let auditChanged = false
  const appendRecord: CodexSessionBackfillAuditWriter = async (record) => {
    const appended = await writeAuditRecord(record)
    auditChanged ||= appended
    return appended
  }

  return {
    appendRecord,
    async recordExisting(summary, source, target, targetStat): Promise<void> {
      const fileEventId = targetStat
        ? createCodexSessionBackfillFileEventId(target, targetStat)
        : undefined
      if (fileEventId && coverage.fileEventIds.has(fileEventId)) {
        summary.skippedExistingFiles += 1
        return
      }
      if (
        await recordExistingCodexSessionForHeal(appendRecord, summary, source, target, fileEventId)
      ) {
        if (fileEventId) {
          coverage.fileEventIds.add(fileEventId)
        }
      }
    },
    async recordPublished(summary, action, source, target): Promise<void> {
      const targetStat = await readCodexSessionTargetStat(target)
      const fileEventId = targetStat
        ? createCodexSessionBackfillFileEventId(target, targetStat)
        : undefined
      if (
        await appendCodexSessionHealAuditRecord(appendRecord, summary, {
          action,
          source,
          target,
          ...(fileEventId ? { fileEventId } : {})
        })
      ) {
        if (fileEventId) {
          coverage.fileEventIds.add(fileEventId)
        }
      }
    },
    async recordDiagnostic(record, sourceStat): Promise<void> {
      const diagnosticEventId = createCodexSessionBackfillDiagnosticEventId({
        ...record,
        sourceStat
      })
      if (coverage.diagnosticEventIds.has(diagnosticEventId)) {
        return
      }
      if (await appendRecord({ ...record, diagnosticEventId })) {
        coverage.diagnosticEventIds.add(diagnosticEventId)
      }
    },
    async finish(summary): Promise<void> {
      if (auditChanged || !coverage.hasRunSummary) {
        await appendRecord({ action: 'run-summary', ...summary })
      }
    }
  }
}

/** A broken symlink at the target still counts as taken. */
export async function readCodexSessionTargetStat(entryPath: string): Promise<Stats | null> {
  try {
    return await lstat(entryPath)
  } catch {
    return null
  }
}
