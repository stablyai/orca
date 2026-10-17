import type { OrchestrationDb } from './db'
import type { MessageRow } from './types'

export function suppressEarlierWorkerHeartbeats(
  db: OrchestrationDb,
  workerDone: MessageRow,
  dispatchId: string
): void {
  const heartbeatIds = db
    .getUnreadMessages(workerDone.to_handle, ['heartbeat'])
    .filter((message) => {
      if (message.sequence >= workerDone.sequence || !message.payload) {
        return false
      }
      try {
        const payload: unknown = JSON.parse(message.payload)
        return (
          payload !== null &&
          typeof payload === 'object' &&
          !Array.isArray(payload) &&
          'dispatchId' in payload &&
          payload.dispatchId === dispatchId
        )
      } catch {
        return false
      }
    })
    .map((message) => message.id)
  db.markAsReadAndDelivered(heartbeatIds)
}
