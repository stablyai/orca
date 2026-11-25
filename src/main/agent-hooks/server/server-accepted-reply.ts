import { mainAgentDoneAt } from '../../../shared/agent-status/lifecycle/main-agent-status'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import type { EnrichedAgentHookEventPayload } from './server-types'

/** The reply an event offers its lead's turn; a child's reply never answers it. */
export function leadReplyOf(event: AgentHookEventPayload): string | undefined {
  return event.toolAgentId === undefined ? event.replyCandidate : undefined
}

/** Admit a lead event's reply with the lead completion this row commits; otherwise keep the previous
 *  reply only for the same owner and lead turn. Returns `row` itself when nothing changes. */
export function withAcceptedReply(
  row: EnrichedAgentHookEventPayload,
  previous: EnrichedAgentHookEventPayload | undefined,
  leadReply: string | undefined,
  sameOwner: boolean
): EnrichedAgentHookEventPayload {
  // Readers name the turn the same way from the public row they selected.
  const leadTurnKey = mainAgentDoneAt({
    state: row.payload.state,
    stateStartedAt: row.stateStartedAt,
    mainAgent: row.payload.mainAgent
  })
  const carried = previous?.acceptedReply
  const accepted =
    leadTurnKey === undefined
      ? undefined
      : leadReply
        ? { text: leadReply, leadTurnKey }
        : sameOwner && carried?.leadTurnKey === leadTurnKey
          ? carried
          : undefined
  if (accepted === row.acceptedReply) {
    return row
  }
  const { acceptedReply: _stale, ...rest } = row
  return accepted ? { ...rest, acceptedReply: accepted } : rest
}
