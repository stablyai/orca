// The plain line naming who sent another agent's message; not a link on mobile yet.

import {
  agentMessageSendersShown,
  type AgentMessageSource
} from '../../../src/shared/agent-session-message-source'

const UNNAMED_SENDER = 'an agent'

/** Null for the person's own message. */
export function agentMessageAttribution(
  lead: 'From' | 'Message from',
  source: AgentMessageSource | undefined
): string | null {
  if (!source) {
    return null
  }
  const { shown, more } = agentMessageSendersShown(source)
  // One name per sender, repeats included: two senders that share a name are still two.
  const names = shown.map((sender) => sender.name ?? UNNAMED_SENDER)
  return `${lead} ${names.length > 0 ? names.join(', ') : UNNAMED_SENDER}${more > 0 ? ` +${more}` : ''}`
}
