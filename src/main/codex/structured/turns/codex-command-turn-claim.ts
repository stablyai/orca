import { parseAgentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionSinkAdmission
} from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'

const CLAIM_BYTES = 4_096

/** Persist the provider turn claim so rewind can place its rows after the command settles. */
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
    { kind: 'turn-claim', identity, providerTurnId },
    { lifecycle: true, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
}
