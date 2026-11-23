// A replaced Chat's unsent queued messages move to the new Chat, in order, so they run there next.
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-host'
import {
  isUnsettledQueuedMessage,
  type QueuedMessageRow
} from '../native-chat/agent-session-journal/queued-messages/queued-message-table'
import { QUEUED_MESSAGE_PAUSED_SEND_FAILED } from '../../shared/agent-session/requests/agent-session-queued-message-wire'

export type QueuedCarryHost = Pick<StructuredAgentSessionHost, 'conversation' | 'serialize'> & {
  deps: Pick<StructuredAgentSessionHost['deps'], 'agents'> & {
    store: Pick<
      StructuredAgentSessionHost['deps']['store'],
      'getConversation' | 'requireWritableRecord'
    >
  }
}

/** Orchestration mail and tasks stay with the old Chat's mailbox, where dropped bot requests tell
 *  their senders; a continuation stays with the cut turn it continues. */
const carried = (card: QueuedMessageRow | null): card is QueuedMessageRow =>
  card !== null &&
  isUnsettledQueuedMessage(card) &&
  !card.body.from?.orchestration &&
  !card.body.connectorClaim

/** A card sends with the choices it was queued with; a Chat on another agent keeps only Plan or
 *  Build, since the old agent's model and effort names mean nothing there. */
function carriedOptions(
  host: QueuedCarryHost,
  card: QueuedMessageRow,
  from: string,
  to: string
): QueuedMessageRow['options'] {
  const agent = host.deps.store.getConversation(to)?.provider
  if (!card.options || !agent) {
    return undefined
  }
  if (agent === host.deps.store.getConversation(from)?.provider) {
    return card.options
  }
  const { interactionMode } = card.options
  return interactionMode &&
    host.deps.agents.definition(agent)?.restingOptions.acceptsKey('interactionMode')
    ? { interactionMode }
    : undefined
}

/** Each card moves inside the old Chat's queue lane, so no edit, Send or delete there lands between
 *  reading it and withdrawing it, and a card someone is editing stays. It is queued in the new Chat
 *  under the same id, with its hold, before it leaves the old one: a crash between leaves a copy in
 *  the old Chat, whose close paused its queue, so nothing runs twice on its own and nothing is lost. */
export async function carryQueuedMessages(
  host: QueuedCarryHost,
  from: string | null,
  to: string
): Promise<void> {
  if (!from || !host.deps.store.getConversation(from)) {
    return
  }
  try {
    const source = (await host.conversation(from)).journal.queuedMessages
    const target = (await host.conversation(to)).journal.queuedMessages
    for (const { messageId } of (await source.list()).filter(carried)) {
      await host.serialize(from, async () => {
        const card = await source.get(messageId)
        if (!carried(card) || (await source.editHeld(messageId))) {
          return
        }
        if (card.body.connectorDelivery) {
          // Its reply is owed from the chat that took it: withdrawn there, its sender is told it
          // stopped, and its next message reaches the new Chat.
          await source.withdraw([messageId])
          return
        }
        const hold = card.state === 'returned' ? QUEUED_MESSAGE_PAUSED_SEND_FAILED : card.holdReason
        const options = carriedOptions(host, card, from, to)
        // No steer: the turn it was meant to join stays in the old Chat, so it runs as its own turn.
        await target.insert({
          messageId,
          body: card.body,
          ...(options ? { options } : {}),
          ...(hold ? { holdReason: hold } : {}),
          ...(card.unattended !== undefined ? { unattended: card.unattended } : {})
        })
        await source.withdraw([messageId])
      })
    }
  } catch (error) {
    console.warn('[bots] could not move queued messages to the new Chat', error)
  }
}
