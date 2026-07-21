import { randomUUID } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { CodexSessionBackfillSummary } from './codex-session-backfill-types'

export type CodexSessionBackfillAuditWriter = (record: Record<string, unknown>) => Promise<boolean>

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

export async function appendCodexSessionHealAuditRecord(
  writer: CodexSessionBackfillAuditWriter,
  summary: CodexSessionBackfillSummary,
  record: Record<string, unknown>
): Promise<void> {
  if (!(await writer(record))) {
    summary.failedHealAuditRecords += 1
  }
}

export async function recordExistingCodexSessionForHeal(
  writer: CodexSessionBackfillAuditWriter,
  summary: CodexSessionBackfillSummary,
  source: string,
  target: string
): Promise<void> {
  summary.skippedExistingFiles += 1
  // Why: this also recovers a rollout installed before a crash or audit
  // failure; thread/read is idempotent for a pre-existing real-home file.
  await appendCodexSessionHealAuditRecord(writer, summary, {
    action: 'existing',
    source,
    target
  })
}
