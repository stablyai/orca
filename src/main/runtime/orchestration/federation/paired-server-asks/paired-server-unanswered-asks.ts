// Asks an agent here took from a paired server and hasn't answered, once their pairing ends: the
// server was removed here, or this computer re-paired with it. Each one ends here as unpaired; an
// unread one is taken, so it isn't worked on for no one.
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { REVERSED_CONVERSATION_SQL } from '../../db/federation/paired-server-asks-store'
import { tellSender } from '../../../rpc/methods/orchestration/messaging/bot-request-sender-notice'

/** Every unanswered ask of this server's reverse conversations, or with `replacedBy`, those of any
 *  pairing but that one. Its asker is told by the conversation it asked on while the pairing can
 *  still take a notice; a replaced pairing takes none (the server told the asker when it ended). */
export function tellUnansweredAskers(
  runtime: OrcaRuntimeService,
  environmentId: string,
  replacedBy?: string
): void {
  const db = runtime.getOrchestrationDb()
  // From this server's reverse conversations (of the replaced pairings only, when re-paired) to
  // their mail and its requests: the work follows that route's mail, never all paired mail.
  const unanswered = db.db
    .prepare(
      `SELECT r.message_id FROM peer_mail_conversations c
       JOIN peer_mail_messages p ON p.conversation_id = c.conversation_id
       JOIN bot_requests r ON r.message_id = p.message_id
       LEFT JOIN bot_request_outcomes o ON o.message_id = r.message_id
       WHERE c.role = 'peer' AND c.environment_id = ?1 AND ${REVERSED_CONVERSATION_SQL}
         AND (?2 IS NULL OR c.peer_fingerprint <> ?2) AND o.message_id IS NULL`
    )
    .all(environmentId, replacedBy ?? null)
  for (const row of unanswered) {
    const message = db.getMessageById(String(row.message_id))
    if (message) {
      tellSender(runtime, db, message, 'dropped', 'unpaired', undefined, () =>
        db.markAsRead([message.id], { kind: 'dropped', why: 'unpaired' })
      )
    }
  }
}
