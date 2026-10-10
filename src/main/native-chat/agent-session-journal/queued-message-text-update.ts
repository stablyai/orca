import type Database from '../../sqlite/sync-database'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { AgentSessionQueuedMessageUpdateResult } from '../../../shared/agent-session-wire'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import { queuedMessageWithEditedText } from '../../../shared/queued-message-text-edit'
import {
  getQueuedMessage,
  isUnsettledQueuedMessage,
  type QueuedMessageRow
} from './queued-message-table'

export type QueuedMessageTextUpdate = {
  messageId: string
  expectedBodyFingerprint: string
  text: string
}

/** Compare-and-set on the body fingerprint. The resulting body is checked first, so a retried
 *  Save whose first answer was lost reads `unchanged`, and one a newer edit superseded reads
 *  `changed`: a retry never overwrites newer text. */
export function queuedMessageTextUpdateDecision(
  row: QueuedMessageRow | null,
  sessionId: string,
  input: QueuedMessageTextUpdate
):
  | AgentSessionQueuedMessageUpdateResult
  | { status: 'ready'; body: AgentJournalMessageItem; fingerprint: string } {
  const { messageId } = input
  if (!row || !isUnsettledQueuedMessage(row)) {
    const disposition = !row ? 'missing' : row.state === 'dispatched' ? 'dispatched' : 'withdrawn'
    return { status: 'gone', messageId, disposition }
  }
  const body = queuedMessageWithEditedText(row.body, input.text)
  if (!body) {
    return { status: 'not-editable', messageId }
  }
  const fingerprint = agentSessionSendBodyFingerprint(sessionId, body)
  if (row.fingerprint === fingerprint) {
    return { status: 'unchanged', messageId, fingerprint }
  }
  if (row.fingerprint !== input.expectedBodyFingerprint) {
    return { status: 'changed', messageId }
  }
  return { status: 'ready', body, fingerprint }
}

/** Inside the journal's draft transaction; only body and fingerprint change, so the card keeps
 *  its id, position, state, holds and hand-off link. */
export function updateQueuedMessageText(
  db: Database.Database,
  sessionId: string,
  input: QueuedMessageTextUpdate
): AgentSessionQueuedMessageUpdateResult {
  const decision = queuedMessageTextUpdateDecision(
    getQueuedMessage(db, sessionId, input.messageId),
    sessionId,
    input
  )
  if (decision.status !== 'ready') {
    return decision
  }
  db.prepare(
    'UPDATE queued_messages SET body_json = ?, fingerprint = ? WHERE session_id = ? AND message_id = ?'
  ).run(JSON.stringify(decision.body), decision.fingerprint, sessionId, input.messageId)
  return { status: 'updated', messageId: input.messageId, fingerprint: decision.fingerprint }
}
