/** How a bot request ends, back to the bot that sent it: the answer's reply carries what to do with it,
 * a post where the asker asked is noted so the answer is never passed on twice, and a request that
 * ends with no answer, or is dropped unread, wakes the sender to tell the asker. */

import type { MessageRow } from '../../../../orchestration/db/orchestration-records'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { BotRequestOutcome } from '../../../../orchestration/db/bot-requests/bot-request-outcomes'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import {
  botAnswerView,
  botRequestAnswerRef,
  botRequestSenderName,
  botRequestUnansweredText
} from '../../../../../bots/bot-request-view'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { botOfSession } from '../../../../../bots/bot-session-tabs'
import { awaitsAnswer } from '../../../../../bots/bot-request-policy'
import { readBotTurn } from './bot-recipient'
import { botRequestRecord } from './bot-request-record'
import { resolveReplyRecipient } from './recipient-routing'
import { mayNameSession } from './session-recipient'
import {
  peerMailSender,
  peerMailSenderLabel,
  queuePeerMailReply
} from '../../../../orchestration/federation/peer-mail/peer-mail-delivery'
import { notifyPeerMailQueued } from '../../../../orchestration/federation/peer-mail/peer-mail-waiters'
import { generateId } from '../../../../orchestration/db/generated-id'
import { readAgentSessionRecordStore } from '../../../../orchestration/addressing/session-lineage/structured-session-lineage'

const ACTIVE_DISPATCH = new Set(['pending', 'dispatched'])

/** The payload a reply to a request carries: what the sender does with the answer. */
export function botAnswerPayload(db: OrchestrationDb, original: MessageRow): string | undefined {
  const answer = botAnswerOf(db, original).botAnswer
  return answer
    ? JSON.stringify({ requestId: answer.requestId, botAnswer: answer.view })
    : undefined
}

/** The answer a reply to a request is, recorded once; empty for a reply to other mail. */
export function botAnswerOf(
  db: OrchestrationDb,
  original: MessageRow
): { botAnswer?: { requestId: string; view: Record<string, string> } } {
  const record = botRequestRecord(db, original.id)
  if (!record) {
    return {}
  }
  // A reply would wake the sender, who expects nothing back, and could start two bots replying in turn.
  if (!awaitsAnswer(record.purpose)) {
    throw new OrchestrationError(
      'invalid_argument',
      `That was status from ${botRequestSenderName(record)}, for your information, so there is nothing to answer and nothing was sent.`
    )
  }
  const answer = db.recordBotAnswer(original.id)
  if (!answer) {
    throw new OrchestrationError(
      'already_answered',
      "You already answered that request, so send new mail if there's more to say."
    )
  }
  return { botAnswer: { requestId: original.id, view: botAnswerView(record, answer.posted) } }
}

/** True when a reply's payload is the answer to this request. */
export function isBotAnswerTo(payload: string | null | undefined, requestId: string): boolean {
  if (!payload) {
    return false
  }
  try {
    const parsed: unknown = JSON.parse(payload)
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      'botAnswer' in parsed &&
      'requestId' in parsed &&
      parsed.requestId === requestId
    )
  } catch {
    return false
  }
}

/** After a post: when it went where the request it answers was asked, the request is answered there. */
export async function noteBotRequestPost(
  runtime: OrcaRuntimeService,
  sessionId: string,
  ref: string | undefined
): Promise<void> {
  const db = runtime.getOrchestrationDb()
  const { turn } = await readBotTurn(runtime, db, sessionId)
  for (const requestId of turn.requestIds) {
    const record = botRequestRecord(db, requestId)
    const answerRef = record ? botRequestAnswerRef(record) : null
    // A message ref in the thread starts with the thread's ref.
    if (answerRef && ref && `${ref}:`.startsWith(`${answerRef}:`)) {
      db.recordBotRequestOutcome(requestId, 'posted')
    }
  }
}

/** A turn on a request ended: with no answer and no work still running for it, the sender is told. */
export async function settleBotRequestTurn(
  runtime: OrcaRuntimeService,
  sessionId: string
): Promise<void> {
  // Every chat's turn ends here; only a bot's can be on a request.
  if (!botOfSession(runtime.bots, sessionId)) {
    return
  }
  const db = runtime.getOrchestrationDb()
  const { turn } = await readBotTurn(runtime, db, sessionId)
  const open = turn.requestIds.filter((id) => db.getBotRequestOutcome(id) === null)
  if (open.length === 0) {
    return
  }
  // Its workers' reports wake it again, still on these requests.
  const working = db
    .listDispatchIdsCreatedBySession(sessionId, 50)
    .some((id) => ACTIVE_DISPATCH.has(db.getDispatchContextById(id)?.status ?? ''))
  const messages = working ? [] : open.map((id) => db.getMessageById(id))
  await ensureSenderRecords(runtime, messages)
  for (const message of messages) {
    if (message) {
      tellSender(runtime, db, message, 'unanswered', 'ended')
    }
  }
}

/** Requests a bot will never read: it was paused or deleted, or its Chat replaced. */
export async function dropUnreadBotRequests(
  runtime: OrcaRuntimeService,
  botId: string,
  why: 'paused' | 'deleted' | 'new-chat',
  /** Only those mailed to this conversation (the Chat a new one replaced). */
  onlyTo?: string
): Promise<void> {
  try {
    const db = runtime.getOrchestrationDb()
    const dropped = db
      .listUnreadBotRequests(botId)
      .map(({ message }) => message)
      .filter((message) => !onlyTo || message.to_handle.endsWith(onlyTo))
    await ensureSenderRecords(runtime, dropped)
    for (const message of dropped) {
      if (tellSender(runtime, db, message, 'dropped', why)) {
        db.markAsRead([message.id])
      }
    }
  } catch (error) {
    // The change itself stands; only the senders go untold.
    console.warn('[bots] could not tell senders of dropped bot requests', error)
  }
}

// Session senders resolve against the session records, which a restart leaves uninstalled until asked.
async function ensureSenderRecords(
  runtime: OrcaRuntimeService,
  requests: readonly (MessageRow | null | undefined)[]
): Promise<void> {
  if (requests.some((request) => request && mayNameSession(request.from_handle))) {
    await runtime.ensureStructuredAgentSessionHost().catch(() => undefined)
  }
}

/** False leaves the request as it was: its sender cannot be verified yet, so a later end retries. */
function tellSender(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  request: MessageRow,
  outcome: BotRequestOutcome,
  why: Parameters<typeof botRequestUnansweredText>[1]
): boolean {
  const record = botRequestRecord(db, request.id)
  if (!record || !awaitsAnswer(record.purpose)) {
    return true
  }
  if (tellPeerSender(runtime, db, request, outcome, botRequestUnansweredText(record, why))) {
    return true
  }
  const sender = reachableSender(runtime, db, request)
  if (sender === 'unverified') {
    return false
  }
  if (!db.recordBotRequestOutcome(request.id, outcome) || sender === 'gone') {
    return true
  }
  const recipient = sender
  const told = db.insertMessage({
    from: request.to_handle,
    to: recipient.to,
    subject: `Re: ${request.subject}`,
    body: botRequestUnansweredText(record, why),
    threadId: request.thread_id ?? request.id,
    runId: recipient.runId
  })
  runtime.notifyMessageArrived(told.to_handle, told.type)
  return true
}

/** A request from a paired computer is told over the conversation it came on, from the bot's own address. */
function tellPeerSender(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  request: MessageRow,
  outcome: BotRequestOutcome,
  body: string
): boolean {
  const route = db.getPeerMailMessage(request.id)
  const conversation = route ? db.getPeerMailConversation(route.conversation_id) : undefined
  if (conversation?.role !== 'peer') {
    return false
  }
  if (db.recordBotRequestOutcome(request.id, outcome)) {
    queuePeerMailReply(db, conversation.conversation_id, generateId('msg'), {
      senderLabel: peerMailSenderLabel(runtime, request.to_handle),
      fromAddress: request.to_handle,
      subject: `Re: ${request.subject}`,
      body,
      threadId: request.thread_id ?? request.id,
      sender: peerMailSender(runtime, request.to_handle)
    })
    notifyPeerMailQueued(db.db)
  }
  return true
}

// 'gone': the sender is proven closed, unknown or on another host, so nothing would read a notice.
// 'unverified': the session records are not installed, which proves neither.
function reachableSender(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  request: MessageRow
): ReturnType<typeof resolveReplyRecipient> | 'gone' | 'unverified' {
  if (mayNameSession(request.from_handle) && !readAgentSessionRecordStore()) {
    return 'unverified'
  }
  try {
    return resolveReplyRecipient({
      runtime,
      db,
      originalFrom: request.from_handle,
      originalRunId: request.run_id,
      // A bot request comes from a chat or a worker, never a terminal agent.
      terminalRecipient: null
    })
  } catch (error) {
    if (error instanceof OrchestrationError) {
      return 'gone'
    }
    throw error
  }
}
