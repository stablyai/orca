// Mail answering a request a chat sent another bot while its conversation's turn ran: the answer, or
// the notice that none came, finishes that ask, so it goes back where the ask came from.
import type { OrchestrationDb } from '../../db/orchestration-db'
import type { MessageRow } from '../../db/orchestration-records'
import { canonicalOrcaSessionId } from '../../addressing/session-lineage/canonical-orca-session-id'
import { isOrcaSessionId } from '../../../../../shared/agent-session/identity/orca-session-address'

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

/** Whether this mail answers a request the reading chat sent from a turn its conversation owned. */
export function answersConversationAsk(
  db: OrchestrationDb | null,
  message: Pick<MessageRow, 'id' | 'payload'> & { thread_id?: string | null },
  readerSessionId: string | undefined
): boolean {
  const requestId = answeredRequestId(message)
  if (!db || !readerSessionId || !requestId || requestId === message.id) {
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
