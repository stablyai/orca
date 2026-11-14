import { selectAgentSessionCurrentRequests } from '../../../../../../src/shared/agent-session/requests/agent-session-current-requests'
import type { StructuredAgentSessionState } from '../../../../../../src/shared/agent-session/structured-agent-session-reducer'
import {
  structuredAgentSessionFollowUpsQueue,
  structuredAgentSessionQueueEnabled
} from '../../../../../../src/shared/agent-session/view/structured-agent-session-queued-cards'

/** The desktop's rule: the alternate flips the setting first, then the queue's own rules decide. */
export function mobileStructuredSendQueues(
  queueCapable: boolean,
  queueFollowUps: boolean,
  state: Pick<StructuredAgentSessionState, 'items' | 'currentRequests' | 'queuedMessages'>,
  send: { alternate?: boolean; isWorking: boolean; stopping: boolean } = {
    isWorking: false,
    stopping: false
  }
): boolean {
  return (
    queueCapable &&
    structuredAgentSessionQueueEnabled(
      structuredAgentSessionFollowUpsQueue(queueFollowUps, send),
      state,
      selectAgentSessionCurrentRequests(state)
    )
  )
}
