/** Snapshot distinct sender provenance and join mail to its surviving Run, Dispatch and message records. */

import type {
  AgentMessageSource,
  AgentMessageSender
} from '../../../shared/agent-session/agent-session-message-source'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { MessageRow, OrchestrationDb } from './db'
import { agentMessageRelation } from './agent-message-relation'
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
  const groups = new Map<string, { message: MailSourceMessage; report: ReportFact }[]>()
  for (const message of input.batch) {
    let group = groups.get(message.from_handle)
    if (!group) {
      group = []
      groups.set(message.from_handle, group)
    }
    group.push({ message, report: reportFact(message) })
  }
  const senders: AgentMessageSender[] = []
  for (const [address, group] of groups) {
    const reported = group.find(({ report }) => report.kind === 'valid')?.report
    const sender = agentMessageSender(
      address,
      input.db,
      input.senderName,
      reported?.kind === 'valid' ? reported.dispatchId : undefined
    )
    const relations = new Map<string, AgentMessageSender['relation']>()
    const values = group.map(({ message, report }) => {
      // Sender and DB are fixed by this group/invocation; every varying evidence field is keyed.
      const key = JSON.stringify([input.mailboxHandle, input.dispatchId, message.run_id, report])
      if (!relations.has(key)) {
        relations.set(
          key,
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
        )
      }
      return relations.get(key)
    })
    const relation = values[0]
    senders.push({
      ...sender,
      ...(relation && values.every((value) => value === relation) ? { relation } : {})
    })
  }
  return {
    kind: 'agent',
    senders,
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
