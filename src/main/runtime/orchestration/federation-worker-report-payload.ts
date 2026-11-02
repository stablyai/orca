import type { WorkerReportOutcome } from './types'
import { OrchestrationError } from './orchestration-error'

export function parseFederatedWorkerReportPayload(payload: string | null): {
  taskId: string
  dispatchId: string
  outcome: WorkerReportOutcome
  filesModified: string[]
  reportPath: string | null
} {
  let parsed: unknown
  try {
    parsed = payload ? JSON.parse(payload) : null
  } catch {
    parsed = null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new OrchestrationError('invalid_argument', 'Federated worker report is invalid.')
  }
  const report = parsed as Record<string, unknown>
  if (
    typeof report.taskId !== 'string' ||
    typeof report.dispatchId !== 'string' ||
    (report.outcome !== 'succeeded' && report.outcome !== 'failed')
  ) {
    throw new OrchestrationError('invalid_argument', 'Federated worker report is incomplete.')
  }
  return {
    taskId: report.taskId,
    dispatchId: report.dispatchId,
    outcome: report.outcome,
    filesModified: Array.isArray(report.filesModified)
      ? report.filesModified.filter((file): file is string => typeof file === 'string')
      : [],
    reportPath: typeof report.reportPath === 'string' ? report.reportPath : null
  }
}
