import { externalConversationTitle } from '../../shared/external-conversation-title'
import type { ConnectorAsker } from '../../shared/connectors/connector-cloud-contract'
import type { NativeChatAgent } from '../../shared/agent-launch/permissions/agent-chat-permission-support'
import { isBotAgent } from '../../shared/bot-types'
import { budgetForEarlierImages } from './connector-asker-image-budget'
import type { AskerImages, StagedConnectorImages } from './connector-asker-images'
import { NOTHING_CARRIED } from './external-conversation-returned-carry'
import { botChatFor, deliveryChatId } from './external-conversation-bots'
import type { ConnectorChatDelivery, LinkableChat } from './external-conversation-chat-delivery'
import type { DeliveryPreparation } from './external-conversation-delivery-preparation'
import type {
  ExternalConversationHost,
  ExternalConversationSeamDeps
} from './external-conversation-host'
import { findLink } from './external-conversation-links'
import {
  refused,
  type ConnectorStartInput,
  type ConversationKey,
  type ConversationStart,
  type Delivery
} from './external-conversation-types'

export async function startConnectorConversation(
  deps: Pick<ExternalConversationSeamDeps, 'store' | 'receipts' | 'askerImages'> & {
    enqueue(run: (signal: AbortSignal) => Promise<Delivery>): Promise<Delivery>
    deliver(chat: LinkableChat, delivery: ConnectorChatDelivery): Promise<Delivery>
    link(chat: LinkableChat, text: string, asker?: ConnectorAsker): void
  },
  host: ExternalConversationHost,
  key: ConversationKey,
  deliveryId: string,
  input: ConnectorStartInput,
  preparation?: DeliveryPreparation
): Promise<ConversationStart> {
  const { agent, target, prompt, ...message } = input
  if (preparation && target.kind === 'bot') {
    preparation.restoreThreadOnRestart({
      ...key,
      botId: target.botId,
      title: externalConversationTitle(key.source, message.asker?.text ?? prompt)
    })
  }
  const initial = await deps.receipts.run(
    key,
    deliveryId,
    'connector.start',
    [agent, target, prompt],
    () =>
      deps.enqueue(async (signal) => {
        const deliverySignal = preparation?.signal(signal) ?? signal
        const stopped = preparation?.stopped(deliverySignal)
        if (stopped) {
          return stopped
        }
        if (!isBotAgent(agent)) {
          return refused('unsupported_agent')
        }
        let stagedImages: StagedConnectorImages | undefined
        let fresh = false
        let expired = false
        const beforeCreate = async (agent: NativeChatAgent) => {
          fresh = true
          if (message.asker && deps.askerImages) {
            stagedImages = await stageInitialImages(deps.askerImages, {
              agent,
              asker: message.asker,
              botId: target.botId,
              conversation: key,
              signal: deliverySignal
            })
          }
          if (preparation?.stopped(deliverySignal)) {
            throw new Error('connector_delivery_stopped')
          }
        }
        try {
          const chat = await botChatFor(
            deps.store,
            host.bots,
            key,
            target,
            preparation ? { deliveryId, signal: deliverySignal, beforeCreate } : undefined
          )
          const delivered =
            'outcome' in chat
              ? chat
              : await deps.deliver(chat, {
                  ...message,
                  text: prompt,
                  deliveryId,
                  signal,
                  ...(stagedImages ? { stagedImages } : {})
                })
          expired = delivered.outcome === 'expired'
          return delivered
        } catch (error) {
          const stoppedDuringStart = preparation?.stopped(deliverySignal)
          if (stoppedDuringStart) {
            expired = stoppedDuringStart.outcome === 'expired'
            return stoppedDuringStart
          }
          throw error
        } finally {
          if (fresh && expired) {
            await host.bots?.forgetUnusedStart?.(deliveryChatId(key, target, deliveryId))
          }
        }
      }),
    preparation
  )
  if (
    preparation &&
    target.kind === 'bot' &&
    (initial.outcome === 'accepted' || initial.outcome === 'unknown') &&
    !findLink(deps.store, key)
  ) {
    // The journal may have committed before the thread link was written.
    const sessionId = deliveryChatId(key, target, deliveryId)
    const chat = host.chat?.current()?.deps.store.getConversation(sessionId)
    if (chat?.location && chat.provider && isBotAgent(chat.provider)) {
      deps.link(
        { sessionId, agent: chat.provider, worktreeId: chat.location.workspaceId, bot: target },
        message.asker?.text ?? prompt,
        message.asker
      )
    }
  }
  return { conversation: key, initial }
}

async function stageInitialImages(
  stage: AskerImages,
  { agent, ...request }: Parameters<AskerImages>[0] & { agent: NativeChatAgent }
): Promise<StagedConnectorImages> {
  let directCount: number | undefined
  const images = await stage({
    ...request,
    earlierBudget: async (direct) => {
      directCount = direct.length
      const available = NOTHING_CARRIED.earlierBudget
      return budgetForEarlierImages(
        agent,
        {
          count: available.count - direct.length,
          bytes: available.bytes - direct.reduce((sum, image) => sum + image.bytes, 0),
          fileIds: new Set(direct.map((image) => image.fileId))
        },
        direct
      )
    }
  }).catch(() => [])
  return {
    direct: images.slice(0, directCount),
    earlier: directCount === undefined ? [] : images.slice(directCount)
  }
}
