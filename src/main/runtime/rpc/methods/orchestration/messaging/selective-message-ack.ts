import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import { getMessagesByIds } from '../../../../orchestration/db/messages/messages-by-id'
import { runLifecycleWriteTransaction } from '../../../../orchestration/db/lifecycle-write-transaction-runner'
import { runOwnsDirectMessageSql } from '../../../../orchestration/db/runs/run-coordinator-mail-routing'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { reconcileLifecycleMessage } from '../../../../orchestration/workers/lifecycle/lifecycle-reconciliation'
import { exposeMessages } from './mailbox-message-receipt'
import { ORCHESTRATION_LEGACY_RUN_ID } from '../../../../../../shared/orchestration/orchestration-rpc-contract'

export function acknowledgeSelectedMessages(
  db: OrchestrationDb,
  mailbox: string,
  ids: string[],
  recordReceipt?: (receipt: unknown) => void,
  residualMailbox?: string
) {
  return runLifecycleWriteTransaction(db.db, 'selective_message_ack', () => {
    const selectedIds = [...new Set(ids)]
    const rows = getMessagesByIds(db, selectedIds)
    const messages = selectedIds.map((id) => {
      const message = rows.get(id)
      if (!message || (message.to_handle !== mailbox && message.to_handle !== residualMailbox)) {
        throw new OrchestrationError(
          'invalid_argument',
          'Every --ack-ids ID must exist and be addressed to the current mailbox. No messages were acknowledged.',
          { effectsApplied: false }
        )
      }
      if (
        message.delivery_contract !== 'current_delivery' ||
        message.run_id === ORCHESTRATION_LEGACY_RUN_ID
      ) {
        throw new OrchestrationError(
          'legacy_read_only',
          'Legacy orchestration messages are inspect-only. No messages were acknowledged.',
          { effectsApplied: false }
        )
      }
      return message
    })
    if (
      !mailbox.startsWith('run:') &&
      !mailbox.startsWith('dispatch:') &&
      db.db
        .prepare(
          `SELECT 1 FROM messages WHERE id IN (SELECT value FROM json_each(?)) AND ${runOwnsDirectMessageSql('messages')} LIMIT 1`
        )
        .get(JSON.stringify(selectedIds))
    ) {
      throw new OrchestrationError(
        'consumer_fenced',
        'Selected mail belongs to a Run. Acknowledge it from that Run consumer.',
        { effectsApplied: false }
      )
    }
    const unread = messages.filter((message) => message.read === 0)
    for (const message of unread) {
      reconcileLifecycleMessage(db, message)
    }
    const markedIds = unread.map((message) => message.id)
    db.markAsRead(markedIds)
    const result = {
      messages: exposeMessages(markedIds.map((id) => db.getMessageById(id)!)),
      count: markedIds.length,
      acknowledged: null,
      markedIds,
      alreadyReadIds: messages.filter((message) => message.read === 1).map((message) => message.id)
    }
    recordReceipt?.(result)
    return result
  })
}
