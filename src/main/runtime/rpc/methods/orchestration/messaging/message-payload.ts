import { OrchestrationError } from '../../../../orchestration/orchestration-error'

export function parseRemoteWorkerPayload(payload: string | undefined): Record<string, unknown> {
  if (!payload) {
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(payload)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? // SAFETY: JSON is narrowed to a non-array object; its property values remain unknown.
        (parsed as Record<string, unknown>)
      : {}
  } catch {
    throw new OrchestrationError('invalid_argument', 'Message payload must be valid JSON.')
  }
}

export function parseMessageTaskId(payload: string | undefined): string | undefined {
  if (!payload) {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(payload)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? // SAFETY: JSON is narrowed to a non-array object before inspecting this optional field.
        typeof (parsed as { taskId?: unknown }).taskId === 'string'
        ? // SAFETY: The preceding check confirms this field is a string.
          (parsed as { taskId: string }).taskId
        : undefined
      : undefined
  } catch {
    return undefined
  }
}

export function isWorkerReportOutcome(value: unknown): value is 'succeeded' | 'failed' {
  return value === 'succeeded' || value === 'failed'
}
