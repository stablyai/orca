/**
 * Who the mail a chat is pointed at is from: every distinct sender, named the
 * way orchestration names a party, and each message's own sender and records. The run, dispatch
 * and message ids join back to orchestration's own rows while those exist.
 */

import type {
  AgentMessageSource,
  AgentMessageSender
} from '../../../shared/agent-session-message-source'
import type { MessageRow, OrchestrationDb } from './db'
import { agentMessageSender, type SenderNameResolver } from './agent-message-sender'

export type MailSourceMessage = Pick<
  MessageRow,
  'id' | 'from_handle' | 'run_id' | 'type' | 'payload'
>

export function structuredMailSource(input: {
  db: OrchestrationDb | null
  mailboxHandle: string
  dispatchId: string | null
  batch: readonly MailSourceMessage[]
  senderName: SenderNameResolver
}): AgentMessageSource {
  const senders = new Map<string, AgentMessageSender>()
  for (const { from_handle: address } of input.batch) {
    if (!senders.has(address)) {
      senders.set(
        address,
        agentMessageSender(
          address,
          input.db,
          input.senderName,
          reportedDispatchId(input.batch, address)
        )
      )
    }
  }
  return {
    kind: 'agent',
    senders: [...senders.values()],
    orchestration: {
      message: 'mail-notice',
      mailbox: input.mailboxHandle,
      dispatchId: input.dispatchId,
      messages: input.batch.map((message) => ({
        messageId: message.id,
        runId: message.run_id,
        from: message.from_handle
      }))
    }
  }
}

/** The dispatch a sender's own `worker_done` here reports: the task it just finished, whose
 *  dispatch that report already settled. */
function reportedDispatchId(
  batch: readonly MailSourceMessage[],
  address: string
): string | undefined {
  for (const message of batch) {
    if (message.from_handle !== address || message.type !== 'worker_done' || !message.payload) {
      continue
    }
    try {
      const payload: unknown = JSON.parse(message.payload)
      const dispatchId =
        typeof payload === 'object' && payload !== null && 'dispatchId' in payload
          ? payload.dispatchId
          : undefined
      if (typeof dispatchId === 'string' && dispatchId.length > 0) {
        return dispatchId
      }
    } catch {
      // A payload that does not parse names no dispatch.
    }
  }
  return undefined
}
