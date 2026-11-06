import { agentJournalSubmissionKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import { PROVIDER_EXIT_ROW_PREFIX } from '../../shared/agent-session/lifecycle/agent-session-stop-row-identity'
import { agentSessionFailureWords } from '../../shared/agent-session/failures/agent-session-failure-words'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import type { ClaudeOpenTurn } from './claude-open-turn'
import type { ClaudeStructuredSessionEvent } from './structured/claude-structured-session-state'

export function journalClaudePluginInputFailure({
  event,
  turn,
  sink,
  finish
}: {
  event: Extract<ClaudeStructuredSessionEvent, { type: 'retiring' }>
  turn: ClaudeOpenTurn
  sink: StructuredAgentSessionEventSink
  finish: (observedAt: number, failed: boolean) => void
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
  const stopped = turn.id !== null && sink.journalStopDecidesTurn?.(turn.id, event.observedAt)
  finish(event.observedAt, !stopped)
  if (stopped) {
    return
  }
  // Physical-exit settlement revises this same row after proof; it must not add another notice.
  sink.appendItem(
    {
      provider: 'orca',
      clientMessageId: `${PROVIDER_EXIT_ROW_PREFIX}${event.sessionId}:${event.fence}:${event.acquisitionGeneration}`
    },
    {
      kind: 'status',
      tone: 'error',
      ...agentSessionFailureWords(event.failure, { surface: 'row', agentName: 'Claude' })
    },
    { turnScope: scope, lifecycle: true, observedAt: event.observedAt }
  )
  sink.publish({ lifecycle: true })
}

export function settleClaudeInterruptedTurn(
  turn: ClaudeOpenTurn,
  observedAt: number,
  failed: boolean
): void {
  turn.settle({
    state: 'interrupted',
    ...(failed ? { outcome: 'failure' as const } : {}),
    completedAt: observedAt
  })
  turn.suppressReopen()
}
