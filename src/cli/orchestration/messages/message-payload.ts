import { getOptionalJsonFlag, getOptionalStringFlag } from '../../arguments/flags'
import { RuntimeClientError } from '../../runtime/connection/types'

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function jsonObjectPayload(rawPayload: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawPayload)
  } catch {
    throw new RuntimeClientError(
      'invalid_argument',
      '--payload must be a JSON object when combined with structured payload flags.'
    )
  }
  if (!isJsonObject(parsed)) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--payload must be a JSON object when combined with structured payload flags.'
    )
  }
  return parsed
}

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
  // Structured flags avoid fragile PowerShell JSON quoting. They override the same keys.
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
  if (rawPayload === undefined) {
    return JSON.stringify(payload)
  }
  return JSON.stringify({ ...jsonObjectPayload(rawPayload), ...payload })
}
