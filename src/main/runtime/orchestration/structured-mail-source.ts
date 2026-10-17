/**
 * One orchestration message as a chat is sent it: its text, and who it is from — its sender, named
 * the way orchestration names a party, and the records it joins back to while those exist.
 */

import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { AgentMessageSource } from '../../../shared/agent-session-message-source'
import type { MessageRow, OrchestrationDb } from './db'
import { agentMessageSender, type SenderNameResolver } from './agent-message-sender'
import type { OrchestrationCliCommand } from './cli-command'
import { formatMessageForChat } from './formatter'

export type MailSourceMessage = Pick<
  MessageRow,
  'id' | 'from_handle' | 'run_id' | 'type' | 'payload'
>

export function structuredMailBody(input: {
  db: OrchestrationDb
  mailboxHandle: string
  dispatchId: string | null
  message: MessageRow
  senderName: SenderNameResolver
  cliCommand: OrchestrationCliCommand
}): AgentJournalMessageItem {
  return {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: formatMessageForChat(input.message, input.cliCommand) }],
    from: structuredMailSource(input)
  }
}

export function structuredMailSource(input: {
  db: OrchestrationDb | null
  mailboxHandle: string
  dispatchId: string | null
  message: MailSourceMessage
  senderName: SenderNameResolver
}): AgentMessageSource {
  const { message } = input
  return {
    kind: 'agent',
    senders: [
      agentMessageSender(
        message.from_handle,
        input.db,
        input.senderName,
        reportedDispatchId(message)
      )
    ],
    orchestration: {
      message: 'mail-notice',
      mailbox: input.mailboxHandle,
      dispatchId: input.dispatchId,
      messages: [{ messageId: message.id, runId: message.run_id, from: message.from_handle }],
      carriesMailContent: true
    }
  }
}

/** The dispatch a sender's own `worker_done` reports: the task it just finished, whose dispatch
 *  that report already settled. */
function reportedDispatchId(message: MailSourceMessage): string | undefined {
  if (message.type !== 'worker_done' || !message.payload) {
    return undefined
  }
  try {
    const payload: unknown = JSON.parse(message.payload)
    const dispatchId =
      typeof payload === 'object' && payload !== null && 'dispatchId' in payload
        ? payload.dispatchId
        : undefined
    return typeof dispatchId === 'string' && dispatchId.length > 0 ? dispatchId : undefined
  } catch {
    // A payload that does not parse names no dispatch.
    return undefined
  }
}
