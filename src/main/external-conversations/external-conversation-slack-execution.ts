import { randomUUID } from 'node:crypto'
import { createStructuredAgentSessionOperationId } from '../../shared/agent-session/lifecycle/operations/structured-agent-session-mutation'
import { createSlackExecutionId } from '../native-chat/agent-session-wire/operations/slack-execution-authority'
import type { ConnectorAsker } from '../../shared/connectors/connector-cloud-contract'
import type {
  ExternalConversationBot,
  ExternalConversationLink
} from '../../shared/connectors/external-conversation-link'
import type { LinkableChat } from './external-conversation-chat-delivery'
import type { LinkedConversation } from './external-conversation-links'
import {
  refused,
  type ConnectorMessage,
  type ConversationKey,
  type Delivery
} from './external-conversation-types'

type Requester = NonNullable<ConnectorAsker['slackRequester']>

export type OpenSlackExecution = (input: {
  sessionId: string
  operationId: string
  reply: {
    account: string
    deliveryId: string
    conversation: { source: 'slack'; externalId: string }
  }
  /** Null must use a fresh context without loading personal or shared memory. */
  requester: Requester | null
}) => Promise<LinkableChat>

export type SlackExecutionRequest = {
  message: ConnectorMessage & { deliveryId: string }
  /** Whether replacing the last thread binding can leave no work or reply behind. */
  replacementReady: (link: ExternalConversationLink) => Promise<boolean>
}

/** Each request gets a new native context. The original conversation key stays with its reply. */
export async function freshSlackExecution(input: {
  key: ConversationKey
  bot: ExternalConversationBot
  message: SlackExecutionRequest['message']
  open: OpenSlackExecution
  linked: () => LinkedConversation | null
  replacementReady: SlackExecutionRequest['replacementReady']
}): Promise<LinkableChat | Delivery> {
  // A Slack Resume would need new authority and a reply route on the original scoped session.
  if (input.message.resume) {
    return refused('agent_not_reachable')
  }
  if (input.key.source !== 'slack' || !input.message.reply) {
    return refused('agent_not_reachable')
  }
  const previous = input.linked()?.link
  if (previous && previous.bot?.botId !== input.bot.botId) {
    return refused('agent_not_reachable')
  }
  const sessionId = createSlackExecutionId()
  const operationId = createStructuredAgentSessionOperationId(randomUUID)
  const bindingCurrent = () => input.linked()?.link.sessionId === previous?.sessionId
  const canReplace = async () =>
    (!previous || (await input.replacementReady(previous))) && bindingCurrent()
  if (!(await canReplace())) {
    return refused('delivery_backlog_full')
  }
  const chat = await input.open({
    sessionId,
    operationId,
    reply: {
      account: input.message.reply.account,
      deliveryId: input.message.deliveryId,
      conversation: { source: 'slack', externalId: input.key.externalId }
    },
    requester: input.message.asker?.slackRequester ?? null
  })
  if (chat.sessionId !== sessionId) {
    return refused('agent_not_reachable')
  }
  if (!(await canReplace())) {
    return refused('delivery_backlog_full')
  }
  return {
    ...chat,
    bot: { kind: 'bot', botId: input.bot.botId },
    slackExecution: { bindingCurrent, operationId }
  }
}
