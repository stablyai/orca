import type { BotGroupMember } from '../../shared/bots/bot-group'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'

/** Membership is already gone: readers of these sessions lose their exact commands now, whether
 *  or not the conversation is loaded, without waiting on the best-effort close. */
export function publishMembershipRevocation(members: readonly BotGroupMember[]): void {
  // No installed host means no structured readers to tell.
  const host = getStructuredAgentSessionHost()
  for (const { sessionId } of members) {
    host?.publishBackgroundTasks(sessionId)
  }
}
