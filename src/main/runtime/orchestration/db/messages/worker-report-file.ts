import { createHash } from 'node:crypto'
import {
  MAX_WORKER_REPORT_BYTES,
  type WorkerReportFile
} from '../../../../../shared/orchestration/workers/worker-report-file'
import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../orchestration-db'

/** Extract bytes supplied by the sender. reportPath only describes the original file. */
export function unpackWorkerReport(payload: string | undefined) {
  if (!payload) {
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return
  }
  if (!parsed || typeof parsed !== 'object' || !('reportContentBase64' in parsed)) {
    return
  }
  const { reportContentBase64, ...fields } = parsed
  if (
    typeof reportContentBase64 !== 'string' ||
    reportContentBase64.length > 4 * Math.ceil(MAX_WORKER_REPORT_BYTES / 3) ||
    !('dispatchId' in fields) ||
    typeof fields.dispatchId !== 'string' ||
    !('reportPath' in fields) ||
    typeof fields.reportPath !== 'string'
  ) {
    throw new OrchestrationError('invalid_argument', 'Invalid worker report attachment.')
  }
  const bytes = Buffer.from(reportContentBase64, 'base64')
  if (bytes.length > MAX_WORKER_REPORT_BYTES || bytes.toString('base64') !== reportContentBase64) {
    throw new OrchestrationError('invalid_argument', 'Invalid worker report attachment bytes.')
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  return {
    contentBase64: reportContentBase64,
    dispatchId: fields.dispatchId,
    reportPath: fields.reportPath,
    sha256,
    payload: JSON.stringify({ ...fields, reportSha256: sha256 })
  }
}

export function readWorkerReportFile(
  db: OrchestrationDb,
  messageId: string,
  run?: string,
  to?: string
): WorkerReportFile {
  const row = db.db
    .prepare(`
    SELECT f.content_base64, CASE WHEN f.message_id IS NULL THEN m.payload END AS inline_payload,
           CASE WHEN f.message_id IS NOT NULL THEN json_extract(m.payload, '$.dispatchId') END AS dispatch_id,
           CASE WHEN f.message_id IS NOT NULL THEN json_extract(m.payload, '$.reportPath') END AS report_path,
           CASE WHEN f.message_id IS NOT NULL THEN json_extract(m.payload, '$.reportSha256') END AS sha256
    FROM messages m LEFT JOIN worker_report_files f ON m.id = f.message_id
    WHERE m.id = ? AND m.type IN ('worker_done', 'status')
      AND (? IS NULL OR m.run_id = ?) AND (? IS NULL OR m.to_handle = ?)
  `)
    .get(messageId, run ?? null, run ?? null, to ?? null, to ?? null)
  // An older Run home kept the execution host's forwarded report inline.
  if (typeof row?.inline_payload === 'string') {
    const file = unpackWorkerReport(row.inline_payload)
    if (file) {
      return {
        messageId,
        contentBase64: file.contentBase64,
        dispatchId: file.dispatchId,
        reportPath: file.reportPath,
        sha256: file.sha256
      }
    }
  }
  if (
    typeof row?.content_base64 !== 'string' ||
    typeof row.dispatch_id !== 'string' ||
    typeof row.report_path !== 'string' ||
    typeof row.sha256 !== 'string'
  ) {
    throw new OrchestrationError(
      'not_found',
      'This mailbox has no captured report for that message.'
    )
  }
  return {
    messageId,
    dispatchId: row.dispatch_id,
    reportPath: row.report_path,
    sha256: row.sha256,
    contentBase64: row.content_base64
  }
}
