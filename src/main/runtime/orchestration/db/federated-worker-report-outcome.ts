import type { WorkerReportOutcome } from '../types'

export function parseFederatedWorkerReportOutcome(
  payload: string
): WorkerReportOutcome | undefined {
  try {
    const message = JSON.parse(payload) as { payload?: unknown }
    if (typeof message.payload !== 'string') {
      return undefined
    }
    const report = JSON.parse(message.payload) as { outcome?: unknown }
    return report.outcome === 'succeeded' || report.outcome === 'failed'
      ? report.outcome
      : undefined
  } catch {
    return undefined
  }
}
