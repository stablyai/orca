// Mail answering a request a chat sent another bot while its conversation's turn ran: the answer, or
// the notice that none came, finishes that ask, so it goes back where the ask came from. So does
// item mail carrying the owner's answer to a question the chat asked during such a turn.
import type { OrchestrationDb } from '../../db/orchestration-db'
import type { MessageRow } from '../../db/orchestration-records'
import { canonicalOrcaSessionId } from '../../addressing/session-lineage/canonical-orca-session-id'
import { isOrcaSessionId } from '../../../../../shared/agent-session/identity/orca-session-address'
import { BOT_ITEM_MAIL_SENDER } from '../../../../../shared/bots/bot-item-note-runs'

/** The request a reply answers: its answer payload names it, else its thread is it. */
function answeredRequestId(
  message: Pick<MessageRow, 'payload'> & { thread_id?: string | null }
): string | null {
  if (message.payload) {
    try {
      const payload: unknown = JSON.parse(message.payload)
      if (
        typeof payload === 'object' &&
        payload !== null &&
        'botAnswer' in payload &&
        'requestId' in payload &&
        typeof payload.requestId === 'string'
      ) {
        return payload.requestId
      }
    } catch {
      // Not an answer's payload; its thread may still name the request.
    }
  }
  return message.thread_id ?? null
}

const sameSession = (a: string, b: string): boolean =>
  a === b ||
  (isOrcaSessionId(a) &&
    isOrcaSessionId(b) &&
    canonicalOrcaSessionId(a) === canonicalOrcaSessionId(b))

/** Whether Orca's item mail carries the owner's answer to a question the reading chat asked; item
 *  mail answers no request, so this is its whole check. */
function answersItemAsk(payloadText: string | null, readerSessionId: string): boolean {
  if (!payloadText) {
    return false
  }
  try {
    const payload: unknown = JSON.parse(payloadText)
    return (
      typeof payload === 'object' &&
      payload !== null &&
      'askedInConversation' in payload &&
      typeof payload.askedInConversation === 'string' &&
      sameSession(payload.askedInConversation, readerSessionId)
    )
  } catch {
    return false
  }
}

/** Whether this mail answers a request, or an item question, the reading chat sent from a turn its
 *  conversation owned. */
export function answersConversationAsk(
  db: OrchestrationDb | null,
  message: Pick<MessageRow, 'id' | 'from_handle' | 'payload'> & { thread_id?: string | null },
  readerSessionId: string | undefined
): boolean {
  if (!readerSessionId) {
    return false
  }
  if (message.from_handle === BOT_ITEM_MAIL_SENDER) {
    return answersItemAsk(message.payload, readerSessionId)
  }
  const requestId = answeredRequestId(message)
  if (!db || !requestId || requestId === message.id) {
    return false
  }
  const row = db.getBotRequest(requestId)
  if (!row) {
    return false
  }
  try {
    const record: unknown = JSON.parse(row.record)
    return (
      typeof record === 'object' &&
      record !== null &&
      'askedInConversation' in record &&
      typeof record.askedInConversation === 'string' &&
      sameSession(record.askedInConversation, readerSessionId)
    )
  } catch {
    return false
  }
}
