import { finishAgentSessionSteps } from '../../../shared/agent-session/agent-session-projection-steps'
/** Pure gate facts for session-turn nudges; busy input steers or queues while the orchestration DB retains mail ownership. */

import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { StructuredAgentSessionWorkScope } from '../../../shared/agent-session/view/structured-agent-session-main-agent-working'
import { activeStructuredAgentSessionTurnIdSteps } from '../../../shared/agent-session/view/structured-agent-session-live-turn'
import { projectStructuredAgentSessionStatusSteps } from '../../../shared/agent-session/view/structured-agent-session-projection'

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
  return finishAgentSessionSteps(structuredSessionGateFactSteps(items, scope))
}

export function* structuredSessionGateFactSteps(
  items: readonly AgentJournalRenderItem[],
  scope?: StructuredAgentSessionWorkScope
): Generator<void, StructuredSessionGateFacts> {
  return {
    turnRunning:
      (yield* activeStructuredAgentSessionTurnIdSteps(
        items,
        scope && ((item) => scope.isCurrentItem(item.itemId))
      )) !== null,
    awaitingHuman:
      (yield* projectStructuredAgentSessionStatusSteps(items, [], undefined, scope)) === 'attention'
  }
}
