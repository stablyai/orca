/** Snapshot distinct sender provenance and join mail to its surviving Run, Dispatch and message records. */

import type {
  AgentMessageSource,
  AgentMessageSender
} from '../../../shared/agent-session/agent-session-message-source'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { MessageRow, OrchestrationDb } from './db'
import { agentMessageSender, type SenderNameResolver } from './agent-message-sender'
import type { OrchestrationCliCommand } from './cli-command'
import { formatMessagePointer } from './formatter'
import type { OrchestrationPointerBatch } from './mailbox-pointer-eligibility'

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

/** The chat turn a structured pointer sends: a terminal's pointer text, with who the mail is from. */
export function structuredMailNotice(input: {
  db: OrchestrationDb
  mailboxHandle: string
  dispatchId: string | null
  batch: OrchestrationPointerBatch
  cliCommand: OrchestrationCliCommand
  senderName: SenderNameResolver
}): AgentJournalMessageItem {
  const { messages, heldDeliveryId } = input.batch
  const text = formatMessagePointer(
    messages.length,
    input.mailboxHandle,
    input.cliCommand,
    heldDeliveryId
  )
  return {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: text.trim() }],
    from: structuredMailSource({ ...input, batch: messages })
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
