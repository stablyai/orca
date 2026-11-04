/** Snapshot distinct sender provenance and join mail to its surviving Run, Dispatch and message records. */

import type {
  AgentMessageSource,
  AgentMessageSender
} from '../../../shared/agent-session/agent-session-message-source'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { MessageRow, OrchestrationDb } from './db'
import { agentMessageRelation } from './agent-message-relation'
import { agentMessageSender, type SenderSnapshotResolver } from './agent-message-sender'
import type { OrchestrationCliCommand } from './cli-command'
import { formatMessageBanner, formatMessagePointer } from './formatter'
import { exposeUtcTimestamp } from './db/utc-timestamp'
import { structuredAgentSessionBlocksTooLarge } from '../../../shared/rpc-contract/structured-agent-session-message-params'

export type MailSourceMessage = Pick<
  MessageRow,
  'id' | 'from_handle' | 'run_id' | 'type' | 'payload'
>

export function structuredMailSource(input: {
  db: OrchestrationDb | null
  mailboxHandle: string
  dispatchId: string | null
  batch: readonly MailSourceMessage[]
  senderSnapshot: SenderSnapshotResolver
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
      input.senderSnapshot,
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

/** One orchestration message as one chat message: the whole message, with who it is from.
 *  `whole` is false when it would exceed a chat message's limit; that one then points at `check`
 *  and stays unread there. */
export function structuredMailMessage(input: {
  db: OrchestrationDb
  mailboxHandle: string
  dispatchId: string | null
  message: MessageRow
  cliCommand: OrchestrationCliCommand
  senderSnapshot: SenderSnapshotResolver
}): { body: AgentJournalMessageItem; whole: boolean } {
  const from = structuredMailSource({ ...input, batch: [input.message] })
  const whole = wholeMailBlocks(input.message, input.cliCommand)
  if (!structuredAgentSessionBlocksTooLarge(whole)) {
    return { body: { kind: 'message', role: 'user', blocks: whole, from }, whole: true }
  }
  const pointer = formatMessagePointer(1, input.mailboxHandle, input.cliCommand).trim()
  return {
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: pointer }], from },
    whole: false
  }
}

/** When a message was written, in whole seconds; a Dispatch's mail counts from no earlier than the
 *  Dispatch, since moved follow-up mail keeps its old time. Unreadable is NaN, never after a Stop. */
export function structuredMailWrittenAt(
  db: OrchestrationDb,
  mailboxHandle: string,
  message: MessageRow
): number {
  const seconds = (at: string | undefined) =>
    Math.floor(Date.parse(exposeUtcTimestamp(at ?? null) ?? '') / 1000)
  const dispatch = mailboxHandle.startsWith('dispatch:')
    ? db.getDispatchContextById?.(mailboxHandle.slice('dispatch:'.length))
    : undefined
  return Math.max(seconds(message.created_at), dispatch ? seconds(dispatch.created_at) : -Infinity)
}

/** Whether a message goes to a chat whole, rather than as a pointer at `check`. */
export function structuredMailFitsWhole(
  message: MessageRow,
  cliCommand: OrchestrationCliCommand
): boolean {
  return !structuredAgentSessionBlocksTooLarge(wholeMailBlocks(message, cliCommand))
}

function wholeMailBlocks(
  message: MessageRow,
  cliCommand: OrchestrationCliCommand
): AgentJournalMessageItem['blocks'] {
  return [{ type: 'text', text: formatMessageBanner(message, { cliCommand }) }]
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

/** The same committed cutoff is used before dispatch and at final admission. */
export function structuredMailAfterStop(createdAt: number, stopAt: number | null): boolean {
  return stopAt === null || createdAt > Math.floor(stopAt / 1000)
}
