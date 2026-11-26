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
import { callerFor, type ConversationChat } from './external-conversation-chat'
import { refused, type ConnectorMessage, type Delivery } from './external-conversation-types'
import type { AskerImages, ConnectorImage } from './connector-asker-images'
import type { DeliveryPreparation } from './external-conversation-delivery-receipts'

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
    preparation?: DeliveryPreparation
  }
): Promise<Delivery> {
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
    const readCarry = (direct: readonly ConnectorImage[]) =>
      readCarriedMessages(chat, link, delivery.reply?.account, direct)
    let carried: CarriedMessages | undefined
    let directCount: number | undefined
    const images =
      link.bot && delivery.asker && delivery.askerImages
        ? await delivery
            .askerImages({
              botId: link.bot.botId,
              conversation: { source: link.source, externalId: link.externalId },
              asker: delivery.asker,
              signal: delivery.signal,
              earlierBudget: async (direct) => {
                directCount = direct.length
                carried = await readCarry(direct)
                return carried.earlierBudget
              }
            })
            .catch(() => [])
        : []
    const direct = images.slice(0, directCount)
    const earlier = directCount === undefined ? [] : images.slice(directCount)
    // A carried card that changed since it was read (a Retry, an edit) refuses the send: read again.
    for (let attempt = 1; ; attempt += 1) {
      carried ??= link.bot && attempt <= CARRY_READS ? await readCarry(direct) : NOTHING_CARRIED
      const fitting = earlierImagesThatFit(earlier, carried)
      const outcome = await sendConnectorTurn(
        chat,
        link,
        delivery,
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
        carried = undefined
        continue
      }
      if (outcome.kind === 'refused') {
        return refused('agent_not_reachable')
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
    return refused(delivery.signal.aborted ? refusalOf(delivery.signal) : 'agent_not_reachable')
  }
}

// Reads of the carried cards before the message goes alone: each retry follows a person's change.
const CARRY_READS = 3

function earlierImagesThatFit(
  images: readonly ConnectorImage[],
  { earlierBudget }: CarriedMessages
) {
  let { count, bytes } = earlierBudget
  return images.filter((image) => {
    if (count <= 0 || image.bytes > bytes || earlierBudget.fileIds.has(image.fileId)) {
      return false
    }
    count -= 1
    bytes -= image.bytes
    return true
  })
}

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
          ...images.map(({ path, fileId }) => ({
            type: 'image-ref' as const,
            path,
            ...(link.source === 'slack' ? { connectorFileId: fileId } : {})
          }))
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
      operationId: createStructuredAgentSessionOperationId(randomUUID),
      expectedRuntimeFence: fence,
      delivery: 'now',
      personsMessage: true,
      // Runs synchronously at admission, so a disable cannot interleave before the send.
      beforeRun: () => {
        if (signal.aborted) {
          throw new Error(refusalOf(signal))
        }
        delivery.preparation?.ready()
        admit()
      }
    }
  })
}
