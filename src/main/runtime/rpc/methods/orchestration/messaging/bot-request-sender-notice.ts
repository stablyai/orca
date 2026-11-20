// Tells a request's sender its outcome once: the outcome commits with its mail or relay row.

import type { MessageRow } from '../../../../orchestration/db/orchestration-records'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { BotRequestOutcome } from '../../../../orchestration/db/bot-requests/bot-request-outcomes'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import {
  botRequestUnansweredText,
  type BotRequestUnansweredWhy
} from '../../../../../bots/bot-request-view'
import { runLifecycleWriteTransaction } from '../../../../orchestration/db/lifecycle-write-transaction-runner'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { awaitsAnswer } from '../../../../../bots/bot-request-policy'
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
import { botRequestNoticePayload } from '../../../../orchestration/mailbox/formatting/imported-peer-item-presentation'
import { readAgentSessionRecordStore } from '../../../../orchestration/addressing/session-lineage/structured-session-lineage'

// Session senders resolve against the session records, which a restart leaves uninstalled until asked.
export async function ensureSenderRecords(
  runtime: OrcaRuntimeService,
  requests: readonly (MessageRow | null | undefined)[]
): Promise<void> {
  if (requests.some((request) => request && mayNameSession(request.from_handle))) {
    await runtime.ensureStructuredAgentSessionHost().catch(() => undefined)
  }
}

/** `takenBy` fences the notice on the take it decided, `unread` on nobody having read it since;
 *  `once` picks the new rule's wording. */
export type BotRequestTelling = {
  outcome: BotRequestOutcome
  why: BotRequestUnansweredWhy
  reason?: string
  takenBy?: string
  unread?: true
  once?: boolean
}

/** The outcome commits with its mail or relay row; false when the sender can't be verified yet. */
export function tellSender(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  request: MessageRow,
  telling: BotRequestTelling
): boolean {
  const record = botRequestRecord(db, request.id)
  if (!record || !awaitsAnswer(record.purpose)) {
    return true
  }
  const body = botRequestUnansweredText(record, telling.why, telling.reason, telling.once)
  const owed = () =>
    telling.takenBy === undefined
      ? db.getBotRequestOutcome(request.id) === null &&
        (!telling.unread ||
          (!db.getMessageById(request.id)?.read && !db.getBotRequest(request.id)?.taken_session_id))
      : db.holdsBotRequestTake(request.id, telling.takenBy)
  const route = db.getPeerMailMessage(request.id)
  const conversation = route ? db.getPeerMailConversation(route.conversation_id) : undefined
  if (conversation?.role === 'peer') {
    // A paired computer's request is told over the conversation it came on.
    const queued = runLifecycleWriteTransaction(db.db, 'tell_peer_bot_request_sender', () => {
      if (!owed() || !db.recordBotRequestOutcome(request.id, telling.outcome)) {
        return false
      }
      queuePeerMailReply(db, conversation.conversation_id, generateId('msg'), {
        senderLabel: peerMailSenderLabel(runtime, request.to_handle),
        fromAddress: request.to_handle,
        subject: `Re: ${request.subject}`,
        body,
        threadId: request.thread_id ?? request.id,
        sender: peerMailSender(runtime, request.to_handle),
        notice: { requestId: request.id, outcome: telling.outcome }
      })
      return true
    })
    if (queued) {
      notifyPeerMailQueued(db.db)
    }
    return true
  }
  const sender = reachableSender(runtime, db, request)
  if (sender === 'unverified') {
    return false
  }
  const told = runLifecycleWriteTransaction(db.db, 'tell_bot_request_sender', () => {
    if (!owed() || !db.recordBotRequestOutcome(request.id, telling.outcome)) {
      return null
    }
    return sender === 'gone'
      ? null
      : db.insertMessage({
          from: request.to_handle,
          to: sender.to,
          subject: `Re: ${request.subject}`,
          body,
          threadId: request.thread_id ?? request.id,
          runId: sender.runId,
          // Names the request, which a thread shared by two requests can't.
          payload: botRequestNoticePayload(request.id, telling.outcome)
        })
  })
  if (told) {
    runtime.notifyMessageArrived(told.to_handle, told.type)
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
      // A sender this host can't check yet (a /clear successor's record not read) may still read it.
      return unverifiableSender(error) ? 'unverified' : 'gone'
    }
    throw error
  }
}

function unverifiableSender(error: OrchestrationError): boolean {
  return (
    typeof error.data === 'object' &&
    error.data !== null &&
    'transient' in error.data &&
    error.data.transient === true
  )
}
