/** Pure gate facts for session-turn nudges; busy input steers or queues while the orchestration DB retains mail ownership. */

import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionWorkScope } from '../../../shared/structured-agent-session-main-agent-working'
import {
  activeStructuredAgentSessionTurnId,
  projectStructuredAgentSessionStatus
} from '../../../shared/structured-agent-session-projection'

/** Every reason retains the pointer; none of them consume mail. */
export type StructuredPointerRetainReason =
  | 'session-not-attached'
  | 'turn-unsettled'
  | 'dispatch-rejected'
  | 'dispatch-unknown'

/** The dispatch states both provider adapters converge on. */
export type StructuredDispatchState = 'accepted' | 'rejected' | 'unknown'

/** Read both facts from the full reduced timeline so downstream callers cannot infer idle from a page. */
export type StructuredSessionGateFacts = {
  turnRunning: boolean
  /** A pending approval or question only a human can clear. */
  awaitingHuman: boolean
}

/** Share the chat projection over the full timeline: settled lifecycle items disappear, and busy ones can lie outside any tail page. */
export function structuredSessionGateFacts(
  items: readonly AgentJournalRenderItem[],
  /** The host's projection of current work (`structuredAgentSessionCurrentWork`). */
  scope?: StructuredAgentSessionWorkScope
): StructuredSessionGateFacts {
  return {
    turnRunning:
      activeStructuredAgentSessionTurnId(
        items,
        scope && ((item) => scope.isCurrentItem(item.itemId))
      ) !== null,
    awaitingHuman: projectStructuredAgentSessionStatus(items, [], undefined, scope) === 'attention'
  }
}

/** Only accepted consumes mail; unknown cannot distinguish a dead provider from delayed acknowledgment. */
export function structuredDispatchDelivered(state: StructuredDispatchState): state is 'accepted' {
  return state === 'accepted'
}

export function retainReasonForDispatch(
  state: Exclude<StructuredDispatchState, 'accepted'>
): StructuredPointerRetainReason {
  return state === 'rejected' ? 'dispatch-rejected' : 'dispatch-unknown'
}
