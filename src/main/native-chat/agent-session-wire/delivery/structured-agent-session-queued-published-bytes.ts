import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionWireRefusal } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import type { SqlAgentSessionJournal as AgentSessionJournal } from '../../agent-session-journal/journal-sql-store'
import { unsettledQueuedMessages } from './structured-agent-session-queued-stop'
import {
  queuedMessagePublishedBytesRefusal,
  publishedQueuedBodyBytes
} from '../../agent-session-journal/queued-messages/queued-message-published-bytes'
export {
  QUEUED_MESSAGES_PUBLISHED_MAX_BYTES,
  QUEUED_MESSAGES_PERSON_RESERVE_BYTES
} from '../../agent-session-journal/queued-messages/queued-message-published-bytes'

/** Refuse frame overflow without trimming; edits replace old body bytes and agent cards preserve user reserve. */
export async function queuedMessagesPublishedBytesRefusal(
  journal: AgentSessionJournal,
  body: AgentJournalMessageItem,
  fromPerson: boolean,
  replacing?: string
): Promise<AgentSessionWireRefusal | null> {
  const bytes = (await unsettledQueuedMessages(journal)).reduce(
    (sum, row) => (row.messageId === replacing ? sum : sum + publishedQueuedBodyBytes(row.body)),
    publishedQueuedBodyBytes(body)
  )
  return queuedMessagePublishedBytesRefusal(bytes, fromPerson)
}
