import { runCoordinatorKey } from './orchestration-caller-identity'
import { readAnswerSenderSnapshot } from '../../../shared/agent-session/answer-sender-snapshot'
/** Snapshot distinct sender provenance and join mail to its surviving Run, Dispatch and message records. */

import type {
  AgentMessageSource,
  AgentMessageSender,
  OrchestrationMailNotice
} from '../../../shared/agent-session/agent-session-message-source'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { MessageRow, OrchestrationDb } from './db'
import { agentMessageRelation } from './agent-message-relation'
import { agentMessageSender, type SenderSnapshotResolver } from './agent-message-sender'
import type { OrchestrationCliCommand } from './cli-command'
import {
  formatMessageBanner,
  formatMessageBannerWithContent,
  formatMessagePointer
} from './formatter'
import { structuredAgentSessionBlocksTooLarge } from '../../../shared/rpc-contract/structured-agent-session-message-params'

export type MailSourceMessage = Pick<
  MessageRow,
  'id' | 'from_handle' | 'run_id' | 'type' | 'payload' | 'answer_sender_snapshot'
> & { thread_id?: string | null }

export function structuredMailSource(input: {
  db: OrchestrationDb | null
  mailboxHandle: string
  dispatchId: string | null
  batch: readonly MailSourceMessage[]
  senderSnapshot: SenderSnapshotResolver
}): AgentMessageSource & { orchestration: OrchestrationMailNotice } {
  const groups = new Map<string, { message: MailSourceMessage; report: ReportFact }[]>()
  for (const message of input.batch) {
    const key = JSON.stringify([message.from_handle, message.answer_sender_snapshot ?? null])
    let group = groups.get(key)
    if (!group) {
      group = []
      groups.set(key, group)
    }
    group.push({ message, report: reportFact(message) })
  }
  const senders: AgentMessageSender[] = []
  for (const group of groups.values()) {
    const address = group[0]!.message.from_handle
    const saved = readAnswerSenderSnapshot(group[0]!.message.answer_sender_snapshot)
    const accepted = saved?.party.address === address ? saved : undefined
    const reported = group.find(({ report }) => report.kind === 'valid')?.report
    const guardedAnswer = accepted
      ? undefined
      : historicalAnswerSender(group[0]!.message, input.db, input.senderSnapshot)
    const sender =
      accepted ??
      guardedAnswer ??
      agentMessageSender(
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
      ...((accepted?.relation ?? relation) && values.every((value) => value === relation)
        ? { relation: accepted?.relation ?? relation }
        : {})
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
  const formatted = formatMessageBannerWithContent(input.message, { cliCommand: input.cliCommand })
  const whole = [{ type: 'text' as const, text: formatted.text }]
  if (!structuredAgentSessionBlocksTooLarge(whole)) {
    return {
      body: {
        kind: 'message',
        role: 'user',
        blocks: whole,
        from: {
          ...from,
          orchestration: {
            ...from.orchestration,
            messages: from.orchestration.messages.map((message) => ({
              ...message,
              content: formatted.content
            }))
          }
        }
      },
      whole: true
    }
  }
  const pointer = formatMessagePointer(1, input.mailboxHandle, input.cliCommand).trim()
  return {
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: pointer }], from },
    whole: false
  }
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

/** Old answers may use today's binding only while the exact accepted answer generation still owns it. */
function historicalAnswerSender(
  message: MailSourceMessage,
  db: OrchestrationDb | null,
  snapshot: SenderSnapshotResolver
): AgentMessageSender | undefined {
  if (!db || !message.from_handle.startsWith('run:') || !message.thread_id) {
    return
  }
  const question = db.getQuestion(message.thread_id)
  const run = db.getRun(message.from_handle.slice(4))
  if (
    !question ||
    question.answer_message_id !== message.id ||
    question.run_id !== run?.id ||
    question.answered_by_generation === null ||
    question.answered_by_generation !== run.consumer_generation
  ) {
    return
  }
  const actor = runCoordinatorKey(run)
  const party = {
    address: message.from_handle,
    terminalHandle: actor.terminalHandle,
    orcaSessionId: actor.orcaSessionId
  }
  const known = snapshot(party)
  return {
    party: { ...party, terminalHandle: null },
    name: known.name,
    ...(known.agent ? { agent: known.agent } : {})
  }
}
