// The one bound on a conversation's queue: the bytes its unsettled cards publish. There is no
// card count limit; the cards' bodies ride every hydrating frame and history answer.

import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { AgentSessionWireRefusal } from '../../../shared/agent-session-wire'
import { refuse } from '../../../shared/agent-session-wire-refusals'
import { REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES } from '../../../shared/remote-runtime-memory-limits'
import { MAX_PROMPT_BYTES } from '../../../shared/rpc-contract/structured-agent-session-params'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { AGENT_SESSION_HISTORY_MAX_PAGE_BYTES } from './agent-session-history-page-bounds'
import { unsettledQueuedMessages } from './structured-agent-session-queued-stop'

/** A frame bound, not a queue limit: every unsettled card's body rides each hydrating frame and
 *  history answer beside a full page, and a frame past the outbound cap closes the remote session. */
export const QUEUED_MESSAGES_PUBLISHED_MAX_BYTES =
  (REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES - AGENT_SESSION_HISTORY_MAX_PAGE_BYTES) / 2

/** Kept free of other agents' cards, so they alone never refuse a person's message: the largest
 *  message's blocks plus its body's own fields. */
export const QUEUED_MESSAGES_PERSON_RESERVE_BYTES = MAX_PROMPT_BYTES + 1024

/** Refused readably rather than trimmed, when the published cards would outgrow their frame room.
 *  Another agent's card must also leave the person's reserve free. `replacing` is an edit's own
 *  card, whose old body the new one takes the place of. */
export function queuedMessagesPublishedBytesRefusal(
  journal: AgentSessionJournal,
  body: AgentJournalMessageItem,
  fromPerson: boolean,
  replacing?: string
): AgentSessionWireRefusal | null {
  const bytes = unsettledQueuedMessages(journal).reduce(
    (sum, row) => (row.messageId === replacing ? sum : sum + publishedBodyBytes(row.body)),
    publishedBodyBytes(body)
  )
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
