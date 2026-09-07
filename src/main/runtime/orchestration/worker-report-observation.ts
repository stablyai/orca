import type { MessageRow } from './types'

export function workerReportObservation(msg: MessageRow): {
  id: string
  authorityId: string
  homeReceivedAt: number
} {
  return {
    id: `worker_report:${msg.id}`,
    authorityId: `run_home:${msg.run_id}`,
    homeReceivedAt: Date.parse(msg.created_at)
  }
}
