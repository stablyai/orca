import type { ChatMailPlace } from '../../../../../shared/connectors/external-conversation-link'
import { readAnswerSenderSnapshot } from '../../../../../shared/agent-session/journal/answer-sender-snapshot'
/** Snapshot distinct sender provenance and join mail to its surviving Run, Dispatch and message records. */

import type {
  AgentMessageSource,
  AgentMessageSender,
  OrchestrationMailNotice
} from '../../../../../shared/agent-session/journal/agent-session-message-source'
import type { AgentJournalMessageItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { MessageRow } from '../../db/orchestration-records'
import type { OrchestrationDb } from '../../db/orchestration-db'
import {
  agentMessageLineage,
  reportsToConversation,
  type Lineage
} from '../senders/agent-message-relation'
import { agentMessageSender, type SenderSnapshotResolver } from '../senders/agent-message-sender'
import { answersConversationAsk } from '../senders/conversation-ask-answer'
import { readMessageSenderDispatch } from '../../db/messages/message-sender-dispatch'
import type { WorkerIdentity } from '../../workers/identity/worker-identity'
import type { OrchestrationCliCommand } from '../../workers/launch/orchestration-cli-command'
import type { ReportFollowUpAction } from '../../../../../shared/orchestration/mailbox/orchestration-report-follow-up'
import {
  formatMessageBannerWithContent,
  formatMessagePointer
} from '../formatting/message-formatting'
import { structuredAgentSessionBlocksTooLarge } from '../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-message-params'
import { botItemMailImageBlocks } from './bot-item-mail-images'
import type { BotItemReportFact } from '../../../../../shared/bots/bot-item-report-hint'

export type MailSourceMessage = Pick<
  MessageRow,
  'id' | 'from_handle' | 'run_id' | 'type' | 'payload' | 'answer_sender_snapshot' | 'created_at'
> & { thread_id?: string | null }

export function structuredMailSource(input: {
  db: OrchestrationDb | null
  mailboxHandle: string
  dispatchId: string | null
  batch: readonly MailSourceMessage[]
  senderSnapshot: SenderSnapshotResolver
  /** The chat reading it, so an answer to a thread ask it passed on goes back to that thread. */
  sessionId?: string
}): AgentMessageSource & { orchestration: OrchestrationMailNotice } {
  const groups = new Map<
    string,
    { message: MailSourceMessage; report: ReportFact; recorded: WorkerIdentity | null }[]
  >()
  for (const message of input.batch) {
    // A reused terminal can send for several Dispatches; each is its own sender.
    const recorded = recordedWorker(input.db, message)
    const key = JSON.stringify([
      message.from_handle,
      message.answer_sender_snapshot ?? null,
      recorded?.dispatchId ?? null
    ])
    let group = groups.get(key)
    if (!group) {
      group = []
      groups.set(key, group)
    }
    group.push({ message, report: reportFact(message), recorded })
  }
  const senders: AgentMessageSender[] = []
  for (const group of groups.values()) {
    const address = group[0]!.message.from_handle
    const saved = readAnswerSenderSnapshot(group[0]!.message.answer_sender_snapshot)
    const accepted = saved?.party.address === address ? saved : undefined
    const reported = group.find(({ report }) => report.kind === 'valid')?.report
    // Orca's record of the sending Dispatch proves lineage whatever that Dispatch's state at delivery.
    const recordedDispatchId = group[0]!.recorded?.dispatchId
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
        recordedDispatchId ?? (reported?.kind === 'valid' ? reported.dispatchId : undefined),
        // The oldest message decides, so mail sent before a rebind never takes the new coordinator.
        group.map(({ message }) => message.created_at).toSorted()[0],
        group[0]!.recorded
      )
    const relations = new Map<string, Lineage | undefined>()
    const values = group.map(({ message, report }) => {
      // Sender and DB are fixed by this group/invocation; every varying evidence field is keyed.
      const key = JSON.stringify([
        input.mailboxHandle,
        input.dispatchId,
        message.run_id,
        message.type,
        report
      ])
      if (!relations.has(key)) {
        relations.set(
          key,
          report.kind === 'invalid'
            ? undefined
            : agentMessageLineage({
                db: input.db,
                sender: sender.party,
                recipient: input.mailboxHandle,
                runId: message.run_id,
                reportedDispatchId:
                  recordedDispatchId ?? (report.kind === 'valid' ? report.dispatchId : undefined),
                recipientDispatchId: input.dispatchId,
                messageType: message.type
              })
        )
      }
      return relations.get(key)
    })
    const relation = values[0]?.relation
    const agreed = values.every((value) => value?.relation === relation)
    const workerReports =
      !accepted && agreed && values.every((value) => value && reportsToConversation(value))
    const askAnswers = group.every(({ message }) =>
      answersConversationAsk(input.db, message, input.sessionId)
    )
    senders.push({
      ...sender,
      ...((accepted?.relation ?? relation) && agreed
        ? { relation: accepted?.relation ?? relation }
        : {}),
      ...(workerReports || askAnswers ? { toConversation: true as const } : {})
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
  followUp: ReportFollowUpAction | undefined
  /** The open item a finished worker was started for: guidance after the report, kept out of its content. */
  reportItem?: BotItemReportFact | null
  /** The chat reading it. */
  sessionId?: string
  /** The reading chat's bound conversation and whether its answer to this mail lands there. */
  conversationPlace?: (from: AgentMessageSource) => ChatMailPlace | null
}): { body: AgentJournalMessageItem; whole: boolean } {
  const from = structuredMailSource({ ...input, batch: [input.message] })
  const formatted = formatMessageBannerWithContent(input.message, {
    cliCommand: input.cliCommand,
    followUp: input.followUp
  })
  const whole = [{ type: 'text' as const, text: formatted.text }]
  // Whole or not is decided without the item line or note, as custody decides it; ones that won't fit are left off.
  if (!structuredAgentSessionBlocksTooLarge(whole)) {
    const guided = input.reportItem
      ? formatMessageBannerWithContent(input.message, {
          cliCommand: input.cliCommand,
          followUp: input.followUp,
          reportItem: input.reportItem
        }).text
      : formatted.text
    const noted = withConversationNote(guided, from, input)
    return {
      body: {
        kind: 'message',
        role: 'user',
        blocks: [
          ...(structuredAgentSessionBlocksTooLarge(noted) ? whole : noted),
          ...botItemMailImageBlocks(input.message)
        ],
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
  const pointer = formatMessagePointer(
    1,
    input.mailboxHandle,
    input.cliCommand,
    undefined,
    undefined,
    [input.message.id]
  ).trim()
  return {
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: pointer }], from },
    whole: false
  }
}

/** In a chat bound to a conversation, mail says where the bot's answer lands: there for its own
 *  workers' reports and other bots' answers to its asks, else Orca. */
function withConversationNote(
  text: string,
  from: ReturnType<typeof structuredMailSource>,
  {
    cliCommand,
    conversationPlace
  }: {
    cliCommand: OrchestrationCliCommand
    conversationPlace?: (from: AgentMessageSource) => ChatMailPlace | null
  }
): { type: 'text'; text: string }[] {
  const bound = conversationPlace?.(from)
  const note = !bound
    ? null
    : bound.answersThere
      ? `[Orca: your final message and \`${cliCommand} bot reply\` (with any files) go to ${bound.place}.]`
      : `[Orca: this mail did not come from ${bound.place}, so your final message stays in Orca.]`
  return [{ type: 'text', text: note ? `${text}\n\n${note}` : text }]
}

/** The worker this mail was recorded from when it was written. */
function recordedWorker(
  db: OrchestrationDb | null,
  message: MailSourceMessage
): WorkerIdentity | null {
  try {
    return db ? readMessageSenderDispatch(db, message.id) : null
  } catch {
    // Failure to resolve a label must not block delivery.
    return null
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
  return agentMessageSender(message.from_handle, db, snapshot)
}
