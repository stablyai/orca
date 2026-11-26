// A conversation's message sent into its native chat, with the messages of the conversation that
// failed to start carried ahead of it (external-conversation-returned-carry).
import { randomUUID } from 'node:crypto'
import { leaveEligibleBatch } from './external-conversation-leave-eligibility'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import { connectorAskerPrompt, connectorPlainMessages } from '../../shared/connector-asker-prompt'
import { CHAT_GONE_REFUSAL } from '../../shared/connectors/connector-cloud-contract'
import { createStructuredAgentSessionOperationId } from '../../shared/agent-session/lifecycle/operations/structured-agent-session-mutation'
import { sendAgentTurn } from '../runtime/orchestration/turn-delivery/send-agent-turn'
import { refusalOf } from './external-conversation-chain'
import { storedConnectorAsker } from '../../shared/connector-message-asker'
import { rejectedSendRefusal } from './external-conversation-failure'
import {
  carriedFields,
  NOTHING_CARRIED,
  readCarriedMessages,
  type CarriedMessages
} from './external-conversation-returned-carry'
import type { ReturnedImageProgress } from './external-conversation-returned-image-progress'
import { callerFor, type ConversationChat } from './external-conversation-chat'
import {
  conversationId,
  refused,
  type ConnectorMessage,
  type Delivery
} from './external-conversation-types'
import {
  ASKER_IMAGES_BUDGET_MS,
  hasEarlierImages,
  type AskerImages,
  type ConnectorImage,
  type StagedConnectorImages
} from './connector-asker-images'
import {
  connectorImageInspection,
  type ConnectorImageInspection
} from './connector-asker-stored-image'
import { getAgentSessionAttachmentStore } from '../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import type { DeliveryPreparation } from './external-conversation-delivery-receipts'
import type { CapabilityProbeCache } from '../../shared/concurrency/capability-probe-cache'
import { budgetForEarlierImages, earlierImagesThatFit } from './connector-asker-image-budget'

/** Sent as a person's message would be: a busy chat takes it into the running turn. A bot's is
 *  labelled with who asked, where and what came before; the chat shows the message alone. Its
 *  conversation's messages that failed to start go first, in the same turn
 *  (external-conversation-returned-carry). */
export async function deliverToChat(
  chat: ConversationChat | null,
  link: ExternalConversationLink,
  // admitted: told the moment the chat takes the message, before its turn can begin; what it
  // returns takes that back when the writer then refused the attempt.
  delivery: ConnectorMessage & {
    signal: AbortSignal
    admitted?: () => (() => void) | void
    deliveryId?: string
    askerImages?: AskerImages
    stagedImages?: StagedConnectorImages
    preparation?: DeliveryPreparation
    missingImages?: CapabilityProbeCache<string>
    returnedImageProgress?: ReturnedImageProgress
  }
): Promise<Delivery> {
  const signal = delivery.preparation?.signal(delivery.signal) ?? delivery.signal
  const stopped = () =>
    delivery.preparation?.stopped(signal) ?? (signal.aborted ? refused(refusalOf(signal)) : null)
  const stoppedBeforePreparation = stopped()
  if (stoppedBeforePreparation) {
    return stoppedBeforePreparation
  }
  if (!chat) {
    return refused('agent_not_reachable')
  }
  // Its chat was deleted: the conversation may start a new one.
  if (!chat.deps.store.getConversation(link.sessionId)) {
    return refused(CHAT_GONE_REFUSAL)
  }
  let admitted = false
  // What takes back an admission the writer then refused.
  const taken: { back?: (() => void) | void } = {}
  const admit = () => {
    if (!admitted) {
      admitted = true
      taken.back = delivery.admitted?.()
    }
  }
  try {
    // The download timeout only limits new image staging. Returned requests use the delivery lease.
    const inspection: ConnectorImageInspection | undefined =
      link.bot &&
      !delivery.stagedImages &&
      delivery.askerImages &&
      hasEarlierImages(link.source, delivery.asker)
        ? connectorImageInspection(
            getAgentSessionAttachmentStore()?.rootDir,
            delivery.preparation
              ? signal
              : AbortSignal.any([signal, AbortSignal.timeout(ASKER_IMAGES_BUDGET_MS)]),
            delivery.missingImages
          )
        : undefined
    let firstCarry: Promise<CarriedMessages> | undefined
    const readCarry = (direct: readonly ConnectorImage[]) =>
      readCarriedMessages(
        chat,
        link,
        delivery.reply?.account,
        direct,
        signal,
        inspection,
        inspection && delivery.returnedImageProgress
          ? {
              owner: delivery.returnedImageProgress,
              key: JSON.stringify([link.sessionId, conversationId(link)])
            }
          : undefined
      )
    const earlierBudget = (carried: CarriedMessages, direct: readonly ConnectorImage[]) =>
      budgetForEarlierImages(link.agent, carried.earlierBudget, direct)
    let carried: CarriedMessages | undefined
    let directCount: number | undefined
    const images =
      link.bot && !delivery.stagedImages && delivery.asker && delivery.askerImages
        ? await delivery
            .askerImages({
              botId: link.bot.botId,
              conversation: { source: link.source, externalId: link.externalId },
              asker: delivery.asker,
              signal,
              earlierBudget: async (direct) => {
                directCount = direct.length
                firstCarry = readCarry(direct)
                return earlierBudget(await firstCarry, direct)
              }
            })
            .catch(() => [])
        : []
    const direct = delivery.stagedImages?.direct ?? images.slice(0, directCount)
    const earlier =
      delivery.stagedImages?.earlier ?? (directCount === undefined ? [] : images.slice(directCount))
    // A carried card that changed since it was read (a Retry, an edit) refuses the send: read again.
    for (let attempt = 1; ; attempt += 1) {
      const stoppedBeforeCarry = stopped()
      if (stoppedBeforeCarry) {
        return stoppedBeforeCarry
      }
      carried =
        link.bot && attempt <= CARRY_READS
          ? await (attempt === 1 && firstCarry ? firstCarry : readCarry(direct))
          : NOTHING_CARRIED
      const stoppedBeforeSend = stopped()
      if (stoppedBeforeSend) {
        return stoppedBeforeSend
      }
      if (!chat.deps.store.getConversation(link.sessionId)) {
        return refused(CHAT_GONE_REFUSAL)
      }
      const fitting = earlierImagesThatFit(earlier, earlierBudget(carried, direct))
      const outcome = await sendConnectorTurn(
        chat,
        link,
        { ...delivery, signal },
        carried,
        [...direct, ...fitting],
        admit
      )
      if (
        outcome.kind === 'refused' &&
        carried.cards.length > 0 &&
        outcome.refusal.details?.reason === 'continuationSuperseded'
      ) {
        // Nothing was admitted: a turn the racing Retry starts isn't this delivery's.
        taken.back?.()
        taken.back = undefined
        admitted = false
        continue
      }
      if (outcome.kind === 'refused') {
        return stopped() ?? refused('agent_not_reachable')
      }
      const dispatched = outcome.kind === 'sent' ? outcome.submission?.dispatchState : 'accepted'
      if (dispatched === 'rejected') {
        // Why the agent couldn't take it (signed out, not installed…), or that a person's Stop did.
        return await rejectedSendRefusal(
          chat,
          link,
          outcome.kind === 'sent' ? outcome.submission : null
        )
      }
      return dispatched === 'unknown'
        ? { outcome: 'unknown', reason: 'writer_failed' }
        : { outcome: 'accepted' }
    }
  } catch {
    if (admitted) {
      return { outcome: 'unknown', reason: 'writer_failed' }
    }
    return stopped() ?? refused('agent_not_reachable')
  }
}

// Reads of the carried cards before the message goes alone: each retry follows a person's change.
const CARRY_READS = 3

function sendConnectorTurn(
  chat: ConversationChat,
  link: ExternalConversationLink,
  delivery: Parameters<typeof deliverToChat>[2],
  carried: CarriedMessages,
  images: readonly ConnectorImage[],
  admit: () => void
) {
  const { asker, note, signal } = delivery
  const attached = new Set([
    ...carried.earlierBudget.fileIds,
    ...images.map((image) => image.fileId)
  ])
  const text = asker
    ? connectorAskerPrompt(link.source, asker, note, { ...delivery, attached })
    : connectorPlainMessages([delivery, ...(delivery.later ?? [])], note)
  // Kept beside the message for the chat's tag, with only the links a tag may open or fetch.
  const stored = asker ? storedConnectorAsker(link.source, asker) : undefined
  const carriedIds = [...carried.deliveryIds, ...(delivery.reply?.carried ?? [])]
  const operationId = createStructuredAgentSessionOperationId(randomUUID)
  const fence = chat.deps.store.getConversation(link.sessionId)?.currentFence ?? 0
  return sendAgentTurn({
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
          ...carried.blocks,
          { type: 'text', text },
          ...images.map(({ path }) => ({ type: 'image-ref' as const, path }))
        ],
        // An event no one asked through is the connector's too, so the turn finds its conversation;
        // a bot's message whose asker didn't parse is someone unknown's, never the owner's.
        ...(asker || delivery.memorySource || link.bot ? { origin: 'connector' as const } : {}),
        ...(stored ? { asker: stored } : {}),
        // Whose delivery this is, kept with it: a prompt its turn raises is that conversation's.
        ...(link.bot
          ? { connectorConversation: { source: link.source, externalId: link.externalId } }
          : {}),
        ...leaveEligibleBatch(link, asker, [
          ...carried.askers.map((each) => ({ asker: each })),
          ...(delivery.later ?? [])
        ]),
        ...carriedFields(carried),
        // Its reply outbox rows commit with this admission (design item 125).
        ...(delivery.reply && delivery.deliveryId
          ? {
              connectorDelivery: {
                account: delivery.reply.account,
                conversation: { source: link.source, externalId: link.externalId },
                deliveryId: delivery.deliveryId,
                ...(carriedIds.length ? { carried: carriedIds } : {})
              }
            }
          : {}),
        ...(delivery.memorySource ? { memorySource: delivery.memorySource } : {})
      },
      operationId,
      expectedRuntimeFence: fence,
      delivery: 'now',
      personsMessage: true,
      // Runs synchronously at admission, so a disable cannot interleave before the send.
      beforeRun: () => {
        if (signal.aborted) {
          throw new Error(refusalOf(signal))
        }
        if (delivery.preparation?.expired()) {
          throw new Error('conversation_cancelled')
        }
        delivery.preparation?.attempting(link.sessionId, operationId)
        admit()
      }
    }
  })
}
