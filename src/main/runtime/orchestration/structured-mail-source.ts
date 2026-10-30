/** Snapshot distinct sender provenance and join mail to its surviving Run, Dispatch and message records. */

import type { AgentMessageSource } from '../../../shared/agent-session/agent-session-message-source'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { MessageRow, OrchestrationDb } from './db'
import { agentMessageRelation } from './agent-message-relation'
import { agentMessageSender, type SenderNameResolver } from './agent-message-sender'
import type { OrchestrationCliCommand } from './cli-command'
import { formatMessageForChat } from './formatter'

export type MailSourceMessage = Pick<
  MessageRow,
  'id' | 'from_handle' | 'run_id' | 'type' | 'payload'
>

export function structuredMailSource(input: {
  db: OrchestrationDb | null
  mailboxHandle: string
  dispatchId: string | null
  message: MailSourceMessage
  senderName: SenderNameResolver
}): AgentMessageSource {
  const message = input.message
  const report = reportFact(message)
  const sender = agentMessageSender(
    message.from_handle,
    input.db,
    input.senderName,
    report.kind === 'valid' ? report.dispatchId : undefined
  )
  const relation =
    report.kind === 'invalid'
      ? undefined
      : agentMessageRelation({
          db: input.db,
          sender: sender.party,
          recipient: input.mailboxHandle,
          runId: message.run_id,
          reportedDispatchId: report.kind === 'valid' ? report.dispatchId : undefined,
          recipientDispatchId: input.dispatchId
        })
  return {
    kind: 'agent',
    senders: [{ ...sender, ...(relation ? { relation } : {}) }],
    orchestration: {
      message: 'mail-notice',
      mailbox: input.mailboxHandle,
      dispatchId: input.dispatchId,
      messages: [{ messageId: message.id, runId: message.run_id, from: message.from_handle }]
    }
  }
}

type ReportFact = { kind: 'mail' } | { kind: 'invalid' } | { kind: 'valid'; dispatchId: string }

function reportFact(message: MailSourceMessage): ReportFact {
  if (message.type !== 'worker_done') {
    return { kind: 'mail' }
  }
  if (message.payload) {
    try {
      const payload: unknown = JSON.parse(message.payload)
      if (
        typeof payload === 'object' &&
        payload !== null &&
        'dispatchId' in payload &&
        typeof payload.dispatchId === 'string' &&
        payload.dispatchId.length > 0
      ) {
        return { kind: 'valid', dispatchId: payload.dispatchId }
      }
    } catch {
      // Invalid evidence stays unknown; delivery and the other messages remain intact.
    }
  }
  return { kind: 'invalid' }
}

/** One canonical report is one ordinary attributed queue message. */
export function structuredMailBody(input: {
  db: OrchestrationDb
  mailboxHandle: string
  dispatchId: string | null
  message: MessageRow
  cliCommand: OrchestrationCliCommand
  senderName: SenderNameResolver
}): AgentJournalMessageItem {
  return {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: formatMessageForChat(input.message, input.cliCommand).trim() }],
    from: structuredMailSource(input)
  }
}
