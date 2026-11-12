import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { PROVIDER_EXIT_ROW_PREFIX } from '../../../../shared/agent-session/lifecycle/agent-session-stop-row-identity'
import { agentSessionFailureWords } from '../../../../shared/agent-session/failures/agent-session-failure-words'
import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import type { ClaudeOpenTurn } from '../turns/claude-open-turn'
import { writeClaudeStopReadings, type ClaudeStopCheck } from '../../claude-stop-readings'
import { estimateStructuredAgentSessionItemBytes } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink-estimate'
import type { ClaudeStructuredSessionEvent } from '../claude-structured-session-state'

export function journalClaudePluginInputFailure({
  event,
  turn,
  sink,
  finish
}: {
  event: Extract<ClaudeStructuredSessionEvent, { type: 'retiring' }>
  turn: ClaudeOpenTurn
  sink: StructuredAgentSessionEventSink
  finish: (observedAt: number, failed: boolean, stopCheck: ClaudeStopCheck | null) => void
}): void {
  if (!turn.isOpen && event.unopenedSend) {
    // A failed dispatched action needs a turn outcome without claiming a provider echo or acceptance.
    turn.open(
      {
        sessionId: event.providerSessionId,
        turnId: `plugin-input:${event.unopenedSend.clientMessageId}`,
        userItemId: agentJournalSubmissionKey(event.unopenedSend.clientMessageId),
        startedAt: event.unopenedSend.requestedAt ?? event.observedAt,
        ...(event.unopenedSend.requestedAt === undefined
          ? {}
          : {
              requestedAt: event.unopenedSend.requestedAt
            })
      },
      event.observedAt
    )
  }
  const scope = turn.turnScope
  // A person's Stop at the write position keeps a plain ending and no failure notice.
  const stopCheck = turn.id !== null ? { turnId: turn.id, endedAt: event.observedAt } : null
  finish(event.observedAt, true, stopCheck)
  // Physical-exit settlement revises this same row after proof; it must not add another notice.
  const identity = {
    provider: 'orca' as const,
    clientMessageId: `${PROVIDER_EXIT_ROW_PREFIX}${event.sessionId}:${event.fence}:${event.acquisitionGeneration}`
  }
  const body = {
    kind: 'status' as const,
    tone: 'error' as const,
    ...agentSessionFailureWords(event.failure, { surface: 'row', agentName: 'Claude' })
  }
  const options = { turnScope: scope, lifecycle: true, observedAt: event.observedAt }
  const readings = {
    ran: { kind: 'literal' as const, identity, body },
    stopped: null,
    reservedBytes: estimateStructuredAgentSessionItemBytes(identity, body)
  }
  if (
    !stopCheck ||
    !writeClaudeStopReadings(sink, stopCheck, readings, options, { publish: false })
  ) {
    sink.appendItem(identity, body, options)
  }
  sink.publish({ lifecycle: true })
}

export function settleClaudeInterruptedTurn(
  turn: ClaudeOpenTurn,
  observedAt: number,
  failed: boolean,
  stopCheck: ClaudeStopCheck | null = null
): void {
  const plain = { state: 'interrupted' as const, completedAt: observedAt }
  turn.settle(
    failed ? { ...plain, outcome: 'failure' } : plain,
    undefined,
    failed && stopCheck ? { check: stopCheck, end: plain } : undefined
  )
  turn.suppressReopen()
}
