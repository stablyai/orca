import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { AgentSessionWireRefusal } from '../../../shared/agent-session-wire'
import { refuse } from '../../../shared/agent-session-wire-refusals'
import { REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES } from '../../../shared/remote-runtime/remote-runtime-memory-limits'
import { MAX_PROMPT_BYTES } from '../../../shared/rpc-contract/structured-agent-session-params'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { AGENT_SESSION_HISTORY_MAX_PAGE_BYTES } from './agent-session-history-page-bounds'
import { unsettledQueuedMessages } from './structured-agent-session-queued-stop'

/** Reserve history-page room within the outbound frame cap; oversized frames close remote sessions. */
export const QUEUED_MESSAGES_PUBLISHED_MAX_BYTES =
  (REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES - AGENT_SESSION_HISTORY_MAX_PAGE_BYTES) / 2

/** Keep room for the largest personal message despite agent-origin cards. */
export const QUEUED_MESSAGES_PERSON_RESERVE_BYTES = MAX_PROMPT_BYTES + 1024

const capacities = new WeakMap<AgentSessionJournal, { revision: string; bytes: number }>()

export function queuedMessagesPublishedBytes(journal: AgentSessionJournal): number {
  const revision = journal.queuedMessages.selectionRevision()
  const prior = capacities.get(journal)
  if (prior?.revision === revision) {
    return prior.bytes
  }
  const bytes = unsettledQueuedMessages(journal).reduce(
    (sum, row) => sum + publishedBodyBytes(row.body),
    0
  )
  capacities.set(journal, { revision, bytes })
  return bytes
}

/** Refuse frame overflow without trimming; edits replace old body bytes and agent cards preserve user reserve. */
export function queuedMessagesPublishedBytesRefusal(
  journal: AgentSessionJournal,
  body: AgentJournalMessageItem,
  fromPerson: boolean,
  replacing?: string
): AgentSessionWireRefusal | null {
  const replaced = replacing ? journal.queuedMessages.get(replacing) : null
  const bytes =
    queuedMessagesPublishedBytes(journal) +
    publishedBodyBytes(body) -
    (replaced && (replaced.state === 'waiting' || replaced.state === 'returned')
      ? publishedBodyBytes(replaced.body)
      : 0)
  const limit = fromPerson
    ? QUEUED_MESSAGES_PUBLISHED_MAX_BYTES
    : QUEUED_MESSAGES_PUBLISHED_MAX_BYTES - QUEUED_MESSAGES_PERSON_RESERVE_BYTES
  return bytes > limit
    ? refuse(
        'agent_session_operation_invalid',
        { reason: 'queueTooLarge' },
        "Too much text is waiting in this chat's queue. Delete a queued message or wait for one to go through."
      )
    : null
}

function publishedBodyBytes(body: AgentJournalMessageItem): number {
  return Buffer.byteLength(JSON.stringify(body), 'utf8')
}
