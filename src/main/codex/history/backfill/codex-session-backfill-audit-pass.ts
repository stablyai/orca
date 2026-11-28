import type { Stats } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import {
  appendCodexSessionHealAuditRecord,
  createCodexSessionBackfillAuditWriter,
  createCodexSessionBackfillDiagnosticEventId,
  createCodexSessionBackfillFileEventId,
  readCodexSessionBackfillAuditCoverage,
  recordExistingCodexSessionForHeal,
  type CodexSessionBackfillAuditCoverage,
  type CodexSessionBackfillAuditWriter
} from './codex-session-backfill-audit'
import type { CodexSessionBackfillSummary } from './codex-session-backfill-types'

const RUN_SUMMARY_TAIL_PROBE_BYTES = 16 * 1024

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
  let coveragePromise: Promise<CodexSessionBackfillAuditCoverage> | null = null
  const getCoverage = (): Promise<CodexSessionBackfillAuditCoverage> => {
    coveragePromise ??= readCodexSessionBackfillAuditCoverage(auditLogPath)
    return coveragePromise
  }
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
      const coverage = await getCoverage()
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
        if (fileEventId && coveragePromise) {
          ;(await coveragePromise).fileEventIds.add(fileEventId)
        }
      }
    },
    async recordDiagnostic(record, sourceStat): Promise<void> {
      const coverage = await getCoverage()
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
      if (auditChanged) {
        await appendRecord({ action: 'run-summary', ...summary })
        return
      }
      if (!coveragePromise && (await tailHasRunSummaryRecord(auditLogPath))) {
        return
      }
      const coverage = await getCoverage()
      if (!coverage.hasRunSummary) {
        await appendRecord({ action: 'run-summary', ...summary })
      }
    }
  }
}

async function tailHasRunSummaryRecord(auditLogPath: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(auditLogPath, 'r')
    const { size } = await handle.stat()
    if (size <= 0) {
      return false
    }
    const readLength = Math.min(size, RUN_SUMMARY_TAIL_PROBE_BYTES)
    const offset = size - readLength
    const buf = Buffer.allocUnsafe(readLength)
    const { bytesRead } = await handle.read(buf, 0, readLength, offset)
    const text = buf.toString('utf-8', 0, bytesRead)
    // Skip the first line if we started mid-file so we only parse complete JSON records.
    const startIndex = offset > 0 ? text.indexOf('\n') + 1 : 0
    if (offset > 0 && startIndex === 0) {
      return false
    }
    for (const line of text.slice(startIndex).split('\n')) {
      if (!line.includes('run-summary') && !line.includes('\\u')) {
        continue
      }
      try {
        const parsed: unknown = JSON.parse(line)
        if (
          parsed &&
          typeof parsed === 'object' &&
          !Array.isArray(parsed) &&
          (parsed as Record<string, unknown>).action === 'run-summary'
        ) {
          return true
        }
      } catch {
        // Ignore torn or non-JSON lines in tail probe; caller falls back to full scan.
      }
    }
    return false
  } catch {
    return false
  } finally {
    await handle?.close().catch(() => {})
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
