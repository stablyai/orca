import type { MessageRow, MessageType } from '../../types'
import type { OrchestrationDb } from '../orchestration-db'

// Why: mailbox routing moves rows with `UPDATE ... SET to_handle` and never rewrites
// `sequence`, so a sequence watermark cannot stand in for batch membership — mail can
// land in the Run mailbox behind an outstanding batch carrying an older sequence.
export function hasQueuedMatchingRunMessages(
  this: OrchestrationDb,
  runId: string,
  deliveryMessages: MessageRow[],
  matchTypes?: MessageType[]
): boolean {
  const conditions: string[] = []
  const params: (string | number)[] = [runId, `run:${runId}`]
  if (matchTypes?.length) {
    conditions.push(`type IN (${matchTypes.map(() => '?').join(',')})`)
    params.push(...matchTypes)
  }
  const deliveredIds = deliveryMessages.map((message) => message.id)
  if (deliveredIds.length > 0) {
    conditions.push(`id NOT IN (${deliveredIds.map(() => '?').join(',')})`)
    params.push(...deliveredIds)
  }
  const index = matchTypes?.length
    ? 'idx_messages_unread_current_run_type'
    : 'idx_messages_unread_current_inbox'
  return Boolean(
    this.db
      .prepare(
        `SELECT 1 FROM messages INDEXED BY ${index}
         WHERE run_id = ? AND to_handle = ? AND read = 0
           AND delivery_contract = 'current_delivery'
           ${conditions.map((condition) => `AND ${condition}`).join(' ')} LIMIT 1`
      )
      .get(...params)
  )
}
