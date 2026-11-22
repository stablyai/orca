import { randomUUID } from 'node:crypto'
import { readAgentSessionFailureFact } from '../../shared/agent-session/failures/agent-session-failure'
import { createStructuredAgentSessionOperationId } from '../../shared/agent-session/lifecycle/operations/structured-agent-session-mutation'
import { connectorAskerPrompt, connectorPlainMessages } from '../../shared/connector-asker-prompt'
import { storedConnectorAsker } from '../../shared/connector-message-asker'
import { CHAT_GONE_REFUSAL } from '../../shared/connectors/connector-cloud-contract'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import { sendAgentTurn } from '../runtime/orchestration/turn-delivery/send-agent-turn'
import { authorizeSlackExecutionSend } from '../native-chat/agent-session-wire/operations/slack-execution-authority'
import { refusalOf } from './external-conversation-chain'
import { callerFor, type ConversationChat } from './external-conversation-chat'
import { connectorFailure } from './external-conversation-failure'
import { refused, type ConnectorMessage, type Delivery } from './external-conversation-types'

/** Sent as a person's message would be: a busy chat takes it into the running turn. A bot's is
 *  labelled with who asked, where and what came before; the chat shows the message alone. */
export async function deliverToChat(
  chat: ConversationChat | null,
  link: ExternalConversationLink,
  // admitted: told the moment the chat takes the message, before its turn can begin.
  delivery: ConnectorMessage & {
    signal: AbortSignal
    admitted?: () => void
    deliveryId?: string
    images?: readonly string[]
    bindingCurrent?: () => boolean
    operationId?: string
  }
): Promise<Delivery> {
  const { asker } = delivery
  if (link.isolatedSlack && (!delivery.reply || !delivery.deliveryId)) {
    return refused('agent_not_reachable')
  }
  const { note } = delivery
  const text = asker
    ? connectorAskerPrompt(link.source, asker, note, delivery)
    : connectorPlainMessages([delivery, ...(delivery.later ?? [])], note)
  // Kept beside the message for the chat's tag, with only the links a tag may open or fetch.
  const stored = asker ? storedConnectorAsker(link.source, asker) : undefined
  const { signal } = delivery
  if (!chat) {
    return refused('agent_not_reachable')
  }
  const record = chat.deps.store.getConversation(link.sessionId)
  // Its chat was deleted: the conversation may start a new one.
  if (!record) {
    return refused(CHAT_GONE_REFUSAL)
  }
  const fence = record.currentFence
  let admitted = false
  let staleBinding = false
  const beforeRun = () => {
    if (signal.aborted) {
      throw new Error(refusalOf(signal))
    }
    if (delivery.bindingCurrent && !delivery.bindingCurrent()) {
      staleBinding = true
      throw new Error('delivery_backlog_full')
    }
    admitted = true
    delivery.admitted?.()
  }
  try {
    const outcome = await sendAgentTurn({
      kind: 'structured-session',
      host: chat,
      sessionId: link.sessionId,
      callerKey: callerFor(link).callerKey,
      // Admission is the receipt; the host's feed tells how the turn went.
      budgetMs: 0,
      turn: {
        body: {
          kind: 'message',
          role: 'user',
          // Its images ride as a person's attached ones would; the chat shows them with the message.
          blocks: [
            { type: 'text', text },
            ...(delivery.images ?? []).map((path) => ({ type: 'image-ref' as const, path }))
          ],
          // An event no one asked through is the connector's too, so the turn finds its conversation;
          // a bot's message whose asker didn't parse is someone unknown's, never the owner's.
          ...(asker || delivery.memorySource || link.bot ? { origin: 'connector' as const } : {}),
          ...(stored ? { asker: stored } : {}),
          // Whose delivery this is, kept with it: a prompt its turn raises is that conversation's.
          ...(link.bot
            ? { connectorConversation: { source: link.source, externalId: link.externalId } }
            : {}),
          // Its reply outbox rows commit with this admission (design item 125).
          ...(delivery.reply && delivery.deliveryId
            ? {
                connectorDelivery: {
                  account: delivery.reply.account,
                  conversation: { source: link.source, externalId: link.externalId },
                  deliveryId: delivery.deliveryId,
                  ...(delivery.reply.carried?.length ? { carried: delivery.reply.carried } : {})
                }
              }
            : {}),
          ...(delivery.memorySource ? { memorySource: delivery.memorySource } : {})
        },
        operationId: delivery.operationId ?? createStructuredAgentSessionOperationId(randomUUID),
        expectedRuntimeFence: fence,
        delivery: link.isolatedSlack ? 'queue' : 'now',
        personsMessage: true,
        // Runs synchronously at admission, so a disable cannot interleave before the send.
        beforeRun: link.isolatedSlack
          ? authorizeSlackExecutionSend(link.sessionId, beforeRun)
          : beforeRun
      }
    })
    if (outcome.kind === 'refused') {
      return refused(staleBinding ? 'delivery_backlog_full' : 'agent_not_reachable')
    }
    const dispatched = outcome.kind === 'sent' ? outcome.submission?.dispatchState : 'accepted'
    if (dispatched === 'rejected') {
      // Why the agent couldn't take it (signed out, not installed…), for the connector to say.
      const fact = readAgentSessionFailureFact(
        outcome.kind === 'sent' ? outcome.submission?.rejection : undefined
      )
      return refused('agent_not_reachable', fact && connectorFailure(fact, link.agent))
    }
    return dispatched === 'unknown'
      ? { outcome: 'unknown', reason: 'writer_failed' }
      : { outcome: 'accepted' }
  } catch {
    if (admitted) {
      return { outcome: 'unknown', reason: 'writer_failed' }
    }
    return refused(
      signal.aborted
        ? refusalOf(signal)
        : staleBinding
          ? 'delivery_backlog_full'
          : 'agent_not_reachable'
    )
  }
}
