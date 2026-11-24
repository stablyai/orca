/** Telling a bot request's sender how it ended: the outcome and its notice commit together, by the
 *  route the request came on, and only to a sender Orca can verify. */

import type { MessageRow } from '../../../../orchestration/db/orchestration-records'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { BotRequestOutcome } from '../../../../orchestration/db/bot-requests/bot-request-outcomes'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { botRequestUnansweredText } from '../../../../../bots/bot-request-view'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { awaitsAnswer } from '../../../../../bots/bot-request-policy'
import { botRequestRecord } from './bot-request-record'
import { resolveReplyRecipient } from './recipient-routing'
import { mayNameSession } from './session-recipient'
import {
  peerMailSender,
  peerMailSenderLabel,
  isReplacedPairingConversation,
  queuePeerMailReply
} from '../../../../orchestration/federation/peer-mail/peer-mail-delivery'
import { notifyPeerMailQueued } from '../../../../orchestration/federation/peer-mail/peer-mail-waiters'
import { generateId, isGeneratedId } from '../../../../orchestration/db/generated-id'
import {
  readAgentSessionRecordStore,
  resolveLineageRunningSession
} from '../../../../orchestration/addressing/session-lineage/structured-session-lineage'
import { ORCA_SESSION_ADDRESS_PREFIX } from '../../../../../../shared/agent-session/identity/orca-session-address-prefix'
import {
  isOrcaSessionId,
  parseOrcaSessionAddress
} from '../../../../../../shared/agent-session/identity/orca-session-address'
import { lookupOrcaAgentSession } from '../../../../orchestration/mailbox/routing/structured-session-mail-address'
import { runLifecycleWriteTransaction } from '../../../../orchestration/db/lifecycle-write-transaction-runner'

// Session senders resolve against the session records, which a restart leaves uninstalled until asked.
export async function ensureSenderRecords(
  runtime: OrcaRuntimeService,
  requests: readonly (MessageRow | null | undefined)[]
): Promise<void> {
  if (requests.some((request) => request && mayNameSession(request.from_handle))) {
    await runtime.ensureStructuredAgentSessionHost().catch(() => undefined)
  }
}

/** False leaves the request as it was: its sender cannot be verified yet, so a later end retries.
 *  `settled` runs in the same write as the outcome whenever the request is settled here. */
export function tellSender(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  request: MessageRow,
  outcome: BotRequestOutcome,
  why: Parameters<typeof botRequestUnansweredText>[1],
  reason?: string,
  settled: () => void = () => {}
): boolean {
  const record = botRequestRecord(db, request.id)
  if (!record || !awaitsAnswer(record.purpose)) {
    settled()
    return true
  }
  const body = botRequestUnansweredText(record, why, reason)
  if (tellPeerSender(runtime, db, request, outcome, body, settled)) {
    return true
  }
  const sender = reachableSender(runtime, db, request)
  if (sender === 'unverified') {
    return false
  }
  // The outcome and its notice commit together, so a crash can't record one without the other.
  const told = runLifecycleWriteTransaction(db.db, 'bot_request_notice', () => {
    settled()
    if (!db.recordBotRequestOutcome(request.id, outcome) || sender === 'gone') {
      return null
    }
    return db.insertMessage({
      from: request.to_handle,
      to: sender.to,
      subject: `Re: ${request.subject}`,
      body,
      threadId: request.thread_id ?? request.id,
      runId: sender.runId
    })
  })
  if (told) {
    // After any write this runs inside commits: the nudge routes mail in a transaction of its own.
    queueMicrotask(() => runtime.notifyMessageArrived(told.to_handle, told.type))
  }
  return true
}

/** A request from a paired computer is told over the conversation it came on, from the bot's own address. */
function tellPeerSender(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  request: MessageRow,
  outcome: BotRequestOutcome,
  body: string,
  settled: () => void
): boolean {
  const route = db.getPeerMailMessage(request.id)
  const conversation = route ? db.getPeerMailConversation(route.conversation_id) : undefined
  // A conversation an older build kept under any other id can take no notice (queuePeerMailReply).
  if (conversation?.role !== 'peer' || !isGeneratedId(conversation.conversation_id, 'peerconv')) {
    return false
  }
  const senderLabel = peerMailSenderLabel(runtime, request.to_handle)
  const sender = peerMailSender(runtime, request.to_handle)
  // The outcome and its queued notice commit together.
  const queued = runLifecycleWriteTransaction(db.db, 'bot_request_peer_notice', () => {
    settled()
    // Its pairing was replaced since (checked in this write): the server told the sender then,
    // and a notice queued now would never go, so it ends here untold, as a sender that is gone.
    if (
      !db.recordBotRequestOutcome(request.id, outcome) ||
      isReplacedPairingConversation(db, conversation.conversation_id)
    ) {
      return false
    }
    queuePeerMailReply(db, conversation.conversation_id, generateId('msg'), {
      senderLabel,
      fromAddress: request.to_handle,
      subject: `Re: ${request.subject}`,
      body,
      threadId: request.thread_id ?? request.id,
      sender,
      notice: { requestId: request.id }
    })
    return true
  })
  if (queued) {
    queueMicrotask(() => notifyPeerMailQueued(db.db))
  }
  return true
}

// 'gone': the sender is proven closed, unknown or on another host, so nothing would read a notice.
// 'unverified': the session records are not installed, or its /clear lineage can't be read yet,
// which proves neither.
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
      return senderLineageUnproven(request.from_handle) ? 'unverified' : 'gone'
    }
    throw error
  }
}

/** A known session whose /clear successor has no readable record yet: not proof that it ended. */
function senderLineageUnproven(from: string): boolean {
  const sessionId = from.startsWith(ORCA_SESSION_ADDRESS_PREFIX)
    ? parseOrcaSessionAddress(from)
    : isOrcaSessionId(from)
      ? from
      : null
  const store = sessionId ? readAgentSessionRecordStore() : null
  if (!sessionId || !store) {
    return false
  }
  try {
    const found = lookupOrcaAgentSession(store, sessionId)
    const known =
      found.kind === 'found'
        ? found.record.sessionId
        : found.kind === 'provider-id'
          ? found.orcaSessionId
          : null
    return known !== null && resolveLineageRunningSession(store, known).kind === 'unverifiable'
  } catch {
    return true
  }
}
