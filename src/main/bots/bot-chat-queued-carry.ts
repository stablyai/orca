// A replaced Chat's unsent queued messages move to the new Chat, in order, so they run there next.
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-host'
import { journalDomainAdmittedPersonal } from '../native-chat/agent-session-journal/journal-domain-queue-rows'
import {
  isUnsettledQueuedMessage,
  type QueuedMessageRow
} from '../native-chat/agent-session-journal/queued-messages/queued-message-table'
import { structuredAgentSessionMessageSendMutation } from '../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { mintAgentSessionOperationId } from '../runtime/orchestration/mailbox/structured-pointer/structured-pointer-operation-id'

export type QueuedCarryHost = Pick<StructuredAgentSessionHost, 'conversation' | 'send'> & {
  deps: {
    store: Pick<
      StructuredAgentSessionHost['deps']['store'],
      'getConversation' | 'requireWritableRecord'
    >
  }
}

/** Each message is queued in the new Chat before it leaves the old one. A crash between leaves a copy
 *  in the old Chat, whose close paused its queue, so nothing runs twice on its own and nothing is lost.
 *  Orchestration mail and tasks stay with the old Chat's mailbox; dropped bot requests tell senders. */
export async function carryQueuedMessages(
  host: QueuedCarryHost,
  botId: string,
  from: string | null,
  to: string
): Promise<void> {
  if (!from || !host.deps.store.getConversation(from)) {
    return
  }
  try {
    const { queuedMessages } = (await host.conversation(from)).journal
    const carried = (card: QueuedMessageRow | null): card is QueuedMessageRow =>
      card !== null && isUnsettledQueuedMessage(card) && !card.body.from?.orchestration
    for (const { messageId } of (await queuedMessages.list()).filter(carried)) {
      // Read again: an earlier send's wait may have let the owner edit or delete this one.
      const card = await queuedMessages.get(messageId)
      if (!carried(card)) {
        continue
      }
      const sent = await host.send(
        { callerKey: `bot-chat:${botId}` },
        {
          ...structuredAgentSessionMessageSendMutation({
            sessionId: to,
            clientOperationId: mintAgentSessionOperationId(Date.now()),
            expectedRuntimeFence: host.deps.store.requireWritableRecord(to).lease.runtimeFence,
            body: card.body,
            delivery: 'queue-if-active'
          }),
          ...(journalDomainAdmittedPersonal(card) ? { personsMessage: true as const } : {})
        }
      )
      if (!sent.ok) {
        // Stops here, so the rest stay in order behind it in the old Chat.
        console.warn('[bots] the new Chat refused a queued message', sent.refusal)
        return
      }
      await queuedMessages.withdraw([card.messageId])
    }
  } catch (error) {
    console.warn('[bots] could not move queued messages to the new Chat', error)
  }
}
