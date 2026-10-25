import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { AgentSessionQueuedMessageUpdateResult } from '../../../shared/agent-session-wire'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import { queuedMessageWithEdit, type QueuedMessageEdit } from '../../../shared/queued-message-edit'
import { isUnsettledQueuedMessage, type QueuedMessageRow } from './queued-message-table'

export type QueuedMessageUpdate = QueuedMessageEdit & {
  messageId: string
  expectedBodyFingerprint: string
}

/** Check the resulting body before CAS so lost Save replies retry safely without overwriting newer edits. */
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
  // Clients unable to display image cards must not create them.
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
