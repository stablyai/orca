import { translate } from '../i18n/mobile-i18n'
import {
  agentMessageSendersShown,
  type AgentMessageSource
} from '../../../src/shared/agent-session/agent-session-message-source'

export function agentMessageAttribution(
  lead: 'From' | 'Message from',
  source: AgentMessageSource | undefined
): string | null {
  if (!source) {
    return null
  }
  const { shown, more } = agentMessageSendersShown(source)
  if (shown.length === 0 || (shown.length === 1 && shown[0].name === null && more === 0)) {
    return lead === 'Message from'
      ? translate('session.agentMessageAttribution.messageFromUnnamed', 'Message from an agent')
      : translate('session.agentMessageAttribution.fromUnnamed', 'From an agent')
  }
  // One name per sender, repeats included: two senders that share a name are still two.
  const sender = shown
    .map(
      (sender) =>
        sender.name ?? translate('session.agentMessageAttribution.unnamedSender', 'an agent')
    )
    .join(', ')
  if (more > 0) {
    return lead === 'Message from'
      ? translate(
          'session.agentMessageAttribution.messageFromMore',
          'Message from {{sender}} +{{count}}',
          { sender, count: more }
        )
      : translate('session.agentMessageAttribution.fromMore', 'From {{sender}} +{{count}}', {
          sender,
          count: more
        })
  }
  return lead === 'Message from'
    ? translate('session.agentMessageAttribution.messageFrom', 'Message from {{sender}}', {
        sender
      })
    : translate('session.agentMessageAttribution.from', 'From {{sender}}', { sender })
}
