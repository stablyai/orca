import { parseAgentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session-journal-types'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionSinkAdmission
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'

const CLAIM_BYTES = 4_096

/** Records on the command's turn which provider turn carried it out. Persisted because nothing
 *  else re-derives it once the command settles, and a rewind has to place that turn's rows. */
export function recordCodexCommandTurnClaim(
  sink: StructuredAgentSessionEventSink,
  commandTurnItemId: string,
  providerTurnId: string
): StructuredAgentSessionSinkAdmission {
  const identity = parseAgentJournalItemKey(commandTurnItemId)
  if (!identity || !sink.tryReviseResolvedItemAndPublish) {
    return { accepted: true }
  }
  return sink.tryReviseResolvedItemAndPublish(
    CLAIM_BYTES,
    (journal) => {
      const body = journal.itemBody(commandTurnItemId)
      // Settled already — by the host, or by a child's death — leaves nothing to annotate.
      return body?.kind === 'turn' && body.state === 'running'
        ? { identity, body: { ...body, providerTurnId } }
        : null
    },
    { lifecycle: true, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
}
