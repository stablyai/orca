import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type {
  AgentJournalRowAttribution,
  AgentJournalStatusItem
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { estimateStructuredAgentSessionItemBytes } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink-estimate'
import {
  CODEX_JOURNAL_ADMITTED,
  type CodexJournalTranslationAdmission
} from './codex-structured-journal-contracts'

/** The turn a terminal error row reports: a failure that is not a retry notice, in a turn. */
export function codexTerminalTurnId(
  body: AgentJournalStatusItem,
  frameTurnId: string | null
): string | null {
  return body.failure && body.failure.kind !== 'providerRetrying' ? frameTurnId : null
}

/** Writes a Codex frame's row. `terminalTurnId`: the turn a terminal error row reports. */
export function writeCodexFrameRow(
  sink: StructuredAgentSessionEventSink,
  identity: AgentJournalItemIdentity,
  body: AgentJournalStatusItem,
  attribution: AgentJournalRowAttribution,
  terminalTurnId: string | null
): CodexJournalTranslationAdmission {
  return terminalTurnId && sink.tryReviseResolvedItem
    ? // A failure a person's Stop of this turn caused is the Stop's, so it shows no error row.
      sink.tryReviseResolvedItem(
        estimateStructuredAgentSessionItemBytes(identity, body),
        {
          kind: 'stop-decided',
          failure: true,
          turnId: terminalTurnId,
          endedAt: Date.now(),
          ran: { kind: 'literal', identity, body },
          stopped: null
        },
        attribution
      )
    : sink.tryAppendItem
      ? sink.tryAppendItem(identity, body, attribution)
      : (sink.appendItem(identity, body, attribution), CODEX_JOURNAL_ADMITTED)
}
