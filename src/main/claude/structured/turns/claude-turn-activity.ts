import { claudeProviderFrameActivity } from '../../../native-chat/agent-session-wire/providers/provider-frame-activity'
import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { claudeProviderFrameKind } from '../launch/claude-structured-provider-fallback'
import type { ClaudeStructuredSessionEvent } from '../claude-structured-session-event'
import type { ClaudeOpenTurn } from './claude-open-turn'
import { claudeStreamTurnSource, isRootClaudeFrame } from './claude-turn-opening'

export function publishClaudeTurnActivity(
  turn: ClaudeOpenTurn,
  sink: StructuredAgentSessionEventSink,
  event: Extract<ClaudeStructuredSessionEvent, { type: 'message' | 'provider-frame' }>
): void {
  const text =
    event.type === 'message'
      ? claudeProviderFrameActivity(claudeProviderFrameKind(event.message), event.message)
      : claudeProviderFrameActivity(event.kind, event.payload)
  if (event.type === 'message' && event.startedSend && isRootClaudeFrame(event.message) && text) {
    turn.ensureOpen(
      event.message,
      claudeStreamTurnSource(event.message),
      event.observedAt ?? Date.now()
    )
  }
  const turnId = turn.id
  if (turnId !== null && text !== undefined) {
    sink.setActivity?.(text ? { turnId, text } : null)
  }
}
