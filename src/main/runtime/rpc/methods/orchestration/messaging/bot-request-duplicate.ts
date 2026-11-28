// The receipt for a bot request its target already has: the earlier mail, and no second message.
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import { exposeMessage } from './mailbox-message-receipt'

export const botRequestDuplicateReceipt =
  (db: OrchestrationDb, targetName: string) =>
  (blocked: { messageId: string }): { sent: false; receipt: unknown } => {
    const earlier = db.getMessageById(blocked.messageId)
    return {
      sent: false,
      receipt: {
        ...(earlier ? { message: exposeMessage(earlier) } : {}),
        duplicate: true,
        next: `${targetName} already has this request, so no second message was sent.`
      }
    }
  }
