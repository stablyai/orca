import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { BotRequestAdmission } from '../../../../orchestration/db/bot-requests/bot-request-store'
import { exposeMessage } from './mailbox-message-receipt'

/** The same send again stores nothing: the request is still open, or it already went unanswered and
 *  would only go unanswered again. The receipt names the earlier one. */
export function botRequestBlockedReceipt(
  db: OrchestrationDb,
  blocked: Exclude<BotRequestAdmission, { kind: 'sent' }>,
  bot: string
): { sent: false; receipt: unknown } {
  const earlier = db.getMessageById(blocked.messageId)
  return {
    sent: false,
    receipt: {
      ...(earlier ? { message: exposeMessage(earlier) } : {}),
      duplicate: true,
      next:
        blocked.kind === 'unanswered'
          ? `${bot} already ended a turn without answering this, so it wasn't sent again. Go on without its answer or tell whoever you're working for; if ${bot} answers later, the answer still reaches you.`
          : `${bot} already has this request, so no second message was sent.`
    }
  }
}
