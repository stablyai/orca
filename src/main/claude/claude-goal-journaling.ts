import type { AgentJournalTurnScope } from '../../shared/agent-session/journal/agent-session-journal-turn-scope'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { estimateStructuredAgentSessionItemBytes } from '../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink-estimate'
import { writeClaudeStopReadings } from './claude-stop-readings'
import type { ClaudeGoalSettlement } from './structured/journal/claude-thread-goal'

/** A goal a person's Stop could keep from completing is decided at the write position. */
export function journalClaudeGoal(
  sink: StructuredAgentSessionEventSink,
  goal: ClaudeGoalSettlement,
  turnId: string | null,
  endedAt: number,
  turnScope: AgentJournalTurnScope
): void {
  const { ran, stopped, adopt } = goal
  if (stopped !== undefined && turnId !== null) {
    const literal = (row: typeof ran) => row && { kind: 'literal' as const, ...row }
    const bytes = (row: typeof ran) =>
      row ? estimateStructuredAgentSessionItemBytes(row.identity, row.body) : 0
    const written = writeClaudeStopReadings(
      sink,
      { turnId, endedAt },
      {
        ran: literal(ran),
        stopped: literal(stopped),
        reservedBytes: Math.max(bytes(ran), bytes(stopped))
      },
      { turnScope },
      { publish: true, ...(adopt ? { onDecided: adopt } : {}) }
    )
    if (written) {
      return
    }
  }
  adopt?.(false)
  if (ran) {
    sink.appendItem(ran.identity, ran.body, { turnScope })
    sink.publish()
  }
}
