import { refuseForwardedShell } from '../../arguments/local-file-input'
import { resolve } from 'node:path'
import { readNodeFileWithinLimit } from '../../../shared/file-content/node-bounded-file-reader'
import { MAX_WORKER_REPORT_BYTES } from '../../../shared/orchestration/workers/worker-report-file'
import {
  getOptionalJsonFlag,
  getOptionalStringFlag,
  getPresentStringFlag
} from '../../arguments/flags'
import { RuntimeClientError } from '../../runtime/connection/types'

export async function getOptionalStructuredMessagePayload(
  flags: Map<string, string | boolean>,
  cwd: string,
  replay?: { contentBase64?: string }
): Promise<string | undefined> {
  const rawPayload = getOptionalJsonFlag(flags, 'payload')
  const taskId = getOptionalStringFlag(flags, 'task-id')
  const dispatchId = getOptionalStringFlag(flags, 'dispatch-id')
  const outcome = getOptionalStringFlag(flags, 'outcome')
  const filesModified = getOptionalStringFlag(flags, 'files-modified')
  const reportPath = getPresentStringFlag(flags, 'report-path')
  const phase = getOptionalStringFlag(flags, 'phase')
  const hasStructuredPayload =
    taskId !== undefined ||
    dispatchId !== undefined ||
    outcome !== undefined ||
    filesModified !== undefined ||
    reportPath !== undefined ||
    phase !== undefined
  if (!hasStructuredPayload) {
    return rawPayload
  }
  if (rawPayload !== undefined) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Use either --payload or structured payload flags, not both.'
    )
  }
  // Structured flags avoid fragile PowerShell JSON quoting.
  const payload: Record<string, string | string[]> = {}
  if (taskId) {
    payload.taskId = taskId
  }
  if (dispatchId) {
    payload.dispatchId = dispatchId
  }
  if (outcome) {
    if (outcome !== 'succeeded' && outcome !== 'failed') {
      throw new RuntimeClientError(
        'invalid_argument',
        'Invalid --outcome. Expected succeeded or failed.'
      )
    }
    payload.outcome = outcome
  }
  if (filesModified) {
    payload.filesModified = filesModified
      .split(',')
      .map((file) => file.trim())
      .filter(Boolean)
  }
  if (reportPath) {
    payload.reportPath = reportPath
    if (flags.get('type') === 'worker_done') {
      const content = replay ? replay.contentBase64 : await captureReportFile(cwd, reportPath)
      if (content !== undefined) {
        payload.reportContentBase64 = content
      }
    }
  }
  if (phase) {
    payload.phase = phase
  }
  return JSON.stringify(payload)
}

async function captureReportFile(cwd: string, path: string): Promise<string> {
  refuseForwardedShell()
  try {
    const { buffer } = await readNodeFileWithinLimit(resolve(cwd, path), MAX_WORKER_REPORT_BYTES, {
      regularFileOnly: true
    })
    return buffer.toString('base64')
  } catch (error) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Cannot capture --report-path ${path}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}
