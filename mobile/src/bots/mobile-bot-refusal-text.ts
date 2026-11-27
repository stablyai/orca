import { agentSessionStartRefusalParts } from '../../../src/shared/agent-session/failures/agent-session-refusal-notice'
import type { AgentSessionRefusalReference } from '../../../src/shared/agent-session/failures/agent-session-wire-refusals'
import { agentSessionRefusalFailure } from '../../../src/shared/agent-session/failures/agent-session-write-failure'
import { mobileAgentSessionWriteNoticeText } from '../session/native-chat/agent-session/agent-session-write-notice-copy'

/** A bot chat its agent refused, in the phone's chat failure words. */
export function mobileBotRefusalText(refusal: AgentSessionRefusalReference): string {
  return mobileAgentSessionWriteNoticeText(
    agentSessionStartRefusalParts(agentSessionRefusalFailure(refusal))
  )
}
