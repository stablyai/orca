// The record this host wrote beside a bot request when it admitted it.
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { BotRequestRecord } from '../../../../../bots/bot-request-view'
import type { BotRequestActsFor } from '../../../../../bots/bot-request-asker'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { runtimeChatHost } from '../../../../../external-conversations/external-conversation-chat'
import type { ActingSender } from './bot-recipient'

/** The record this host wrote for a request; null for mail that isn't one. */
export function botRequestRecord(db: OrchestrationDb, messageId: string): BotRequestRecord | null {
  const request = db.getBotRequest(messageId)
  if (!request) {
    return null
  }
  try {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only sendBotRequest writes this column, from a BotRequestRecord.
    return JSON.parse(request.record) as BotRequestRecord
  } catch {
    return null
  }
}

/** Whom a request acts for, and the event that started its chain, as this host recorded it; null
 *  when there is no readable record. */
export function botRequestActsFor(
  db: OrchestrationDb,
  messageId: string
): BotRequestActsFor | null {
  const record = botRequestRecord(db, messageId)
  if (!record || !Array.isArray(record.askers)) {
    return null
  }
  return {
    askers: record.askers,
    ...(Array.isArray(record.askedBy) ? { askedBy: record.askedBy } : {}),
    ...(record.origin ? { origin: record.origin } : {})
  }
}

/** A chat's request sent while its conversation's turn ran: a thread ask passed on to another bot,
 *  whose answer finishes it there (conversation-ask-answer.ts reads it). A worker's is its own. */
export function askedInConversation(
  runtime: OrcaRuntimeService,
  acting: Pick<ActingSender, 'sessionId' | 'worker'>
): Pick<BotRequestRecord, 'askedInConversation'> {
  const { sessionId } = acting
  const asked =
    !acting.worker &&
    sessionId &&
    runtime.getExternalConversationSeam()?.conversationTurn(runtimeChatHost(runtime), sessionId)
  return asked ? { askedInConversation: sessionId } : {}
}

/** The request from another chat that the sending turn answers, when that request wants an answer
 *  (not status): what this request brings back is passed on there, not left on this chat's card. A
 *  worker's send is its own. */
export function answersRequest(
  db: OrchestrationDb,
  acting: Pick<ActingSender, 'worker' | 'turn'>
): Pick<BotRequestRecord, 'answersRequest'> {
  const id = acting.worker ? null : acting.turn.actingOnRequestId
  const purpose = id ? botRequestRecord(db, id)?.purpose : undefined
  return id && purpose && purpose !== 'status' ? { answersRequest: id } : {}
}
