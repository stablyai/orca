import { agentSessionStartRefusalParts } from '../../../src/shared/agent-session/failures/agent-session-refusal-notice'
import type { AgentSessionRefusalReference } from '../../../src/shared/agent-session/failures/agent-session-wire-refusals'
import { agentSessionRefusalFailure } from '../../../src/shared/agent-session/failures/agent-session-write-failure'
import type { Translate } from '../i18n/mobile-i18n'
import { mobileAgentSessionWriteNoticeText } from '../session/native-chat/agent-session/agent-session-write-notice-copy'

/** A bot chat its agent refused, in the phone's chat failure words. */
export function mobileBotRefusalText(refusal: AgentSessionRefusalReference, t: Translate): string {
  return mobileAgentSessionWriteNoticeText(
    agentSessionStartRefusalParts(agentSessionRefusalFailure(refusal)),
    t
  )
}
