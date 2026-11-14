import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  type AgentSessionWireRefusal,
  refuse
} from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import { REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES } from '../../../../shared/remote-runtime/remote-runtime-memory-limits'
import '../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-params'
import { MAX_PROMPT_BYTES } from '../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-message-params'
import { AGENT_SESSION_HISTORY_MAX_PAGE_BYTES } from '../../agent-session-wire/publication/history/agent-session-history-page-bounds'

/** Reserve history-page room within the outbound frame cap; oversized frames close remote sessions. */
export const QUEUED_MESSAGES_PUBLISHED_MAX_BYTES =
  (REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES - AGENT_SESSION_HISTORY_MAX_PAGE_BYTES) / 2

/** Keep room for the largest personal message despite agent-origin cards. */
export const QUEUED_MESSAGES_PERSON_RESERVE_BYTES = MAX_PROMPT_BYTES + 1024

export function queuedMessagePublishedBytesRefusal(
  bytes: number,
  fromPerson: boolean
): AgentSessionWireRefusal | null {
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

export function publishedQueuedBodyBytes(body: AgentJournalMessageItem): number {
  return Buffer.byteLength(JSON.stringify(body), 'utf8')
}
