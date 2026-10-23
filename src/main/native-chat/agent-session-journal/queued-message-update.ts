import type Database from '../../sqlite/sync-database'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { AgentSessionQueuedMessageUpdateResult } from '../../../shared/agent-session-wire'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import { queuedMessageWithEdit, type QueuedMessageEdit } from '../../../shared/queued-message-edit'
import {
  getQueuedMessage,
  isUnsettledQueuedMessage,
  type QueuedMessageRow
} from './queued-message-table'

export type QueuedMessageUpdate = QueuedMessageEdit & {
  messageId: string
  expectedBodyFingerprint: string
}

/** Compare-and-set on the body fingerprint. The resulting body is checked first, so a retried
 *  Save whose first answer was lost reads `unchanged`, and one a newer edit superseded reads
 *  `changed`: a retry never overwrites newer text. */
export function queuedMessageUpdateDecision(
  row: QueuedMessageRow | null,
  sessionId: string,
  input: QueuedMessageUpdate,
  readsImageCards = true
):
  | AgentSessionQueuedMessageUpdateResult
  | {
      status: 'ready'
      body: AgentJournalMessageItem
      previous: AgentJournalMessageItem
      fingerprint: string
    } {
  const { messageId } = input
  if (!row || !isUnsettledQueuedMessage(row)) {
    const disposition = !row ? 'missing' : row.state === 'dispatched' ? 'dispatched' : 'withdrawn'
    return { status: 'gone', messageId, disposition }
  }
  const edited = queuedMessageWithEdit(row.body, input)
  // A caller shown no image card must not make one it then cannot see.
  if (!edited.ok || (!readsImageCards && (input.images?.length ?? 0) > 0)) {
    return { status: 'not-editable', messageId }
  }
  const fingerprint = agentSessionSendBodyFingerprint(sessionId, edited.body)
  if (row.fingerprint === fingerprint) {
    return { status: 'unchanged', messageId, fingerprint }
  }
  if (row.fingerprint !== input.expectedBodyFingerprint) {
    return { status: 'changed', messageId }
  }
  return { status: 'ready', body: edited.body, previous: row.body, fingerprint }
}

/** Inside the journal's draft transaction; only body and fingerprint change, so the card keeps
 *  its id, position, state, holds and hand-off link. The new body's uploads are claimed in the
 *  same transaction (`claim` throws to roll the edit back when one it newly names is gone). */
export function updateQueuedMessage(
  db: Database.Database,
  sessionId: string,
  input: QueuedMessageUpdate,
  claim: (body: AgentJournalMessageItem, previous: AgentJournalMessageItem) => void
): AgentSessionQueuedMessageUpdateResult {
  const decision = queuedMessageUpdateDecision(
    getQueuedMessage(db, sessionId, input.messageId),
    sessionId,
    input
  )
  if (decision.status !== 'ready') {
    return decision
  }
  claim(decision.body, decision.previous)
  db.prepare(
    'UPDATE queued_messages SET body_json = ?, fingerprint = ? WHERE session_id = ? AND message_id = ?'
  ).run(JSON.stringify(decision.body), decision.fingerprint, sessionId, input.messageId)
  return { status: 'updated', messageId: input.messageId, fingerprint: decision.fingerprint }
}
