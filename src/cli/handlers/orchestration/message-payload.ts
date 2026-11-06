import { getOptionalJsonFlag, getOptionalStringFlag } from '../../flags'
import { RuntimeClientError } from '../../runtime-client'
import { parseScheduledWaitUntil } from '../../../shared/orchestration-scheduled-wait'

export function getOptionalStructuredMessagePayload(
  flags: Map<string, string | boolean>
): string | undefined {
  const rawPayload = getOptionalJsonFlag(flags, 'payload')
  const taskId = getOptionalStringFlag(flags, 'task-id')
  const dispatchId = getOptionalStringFlag(flags, 'dispatch-id')
  const outcome = getOptionalStringFlag(flags, 'outcome')
  const filesModified = getOptionalStringFlag(flags, 'files-modified')
  const reportPath = getOptionalStringFlag(flags, 'report-path')
  const phase = getOptionalStringFlag(flags, 'phase')
  const waitUntil = getOptionalStringFlag(flags, 'wait-until')
  const hasStructuredPayload =
    taskId !== undefined ||
    dispatchId !== undefined ||
    outcome !== undefined ||
    filesModified !== undefined ||
    reportPath !== undefined ||
    phase !== undefined ||
    waitUntil !== undefined
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
  }
  if (phase) {
    payload.phase = phase
  }
  if (waitUntil) {
    if (
      (getOptionalStringFlag(flags, 'type') ?? 'status') !== 'status' ||
      !getOptionalStringFlag(flags, 'body')?.trim()
    ) {
      throw new RuntimeClientError(
        'invalid_argument',
        '--wait-until requires a status message and a nonempty --body explaining the reason.'
      )
    }
    try {
      payload.waitUntil = parseScheduledWaitUntil(waitUntil)
    } catch (error) {
      throw new RuntimeClientError(
        'invalid_argument',
        error instanceof Error ? error.message : 'Invalid wait deadline.'
      )
    }
  }
  return JSON.stringify(payload)
}
