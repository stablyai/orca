// The record this host wrote beside a bot request when it admitted it.
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { BotRequestRecord } from '../../../../../bots/bot-request-view'
import type { Bot } from '../../../../../../shared/bot-types'
import type { PairedSender } from '../../../../../../shared/orchestration/mailbox/paired-sender-name'
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
 *  when there is no readable record. Only a handoff passes on the place its chain started in: a
 *  question's answer and a status's follow-up belong to the sending bot, so the turn that takes one
 *  owes that place nothing (no item it adds links it, no request it sends carries it on). Beside a
 *  handoff, they leave the turn no single place: the handoff's item names its request instead. */
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
    ...(record.origin ? { origin: record.origin } : {}),
    ...(record.originPlace && record.purpose === 'handoff'
      ? { originPlace: record.originPlace }
      : {})
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

/** The first request from another chat that the sending turn answers, when that request wants an answer
 *  (not status): what this request brings back is passed on there, not left on this chat's card. A
 *  worker's send is its own. */
export function answersRequest(
  db: OrchestrationDb,
  acting: Pick<ActingSender, 'worker' | 'turn'>
): Pick<BotRequestRecord, 'answersRequest'> {
  if (acting.worker) {
    return {}
  }
  // A turn can take several requests at once; status mail among them wants no answer.
  const id = acting.turn.requestIds.find((requestId) => {
    const purpose = botRequestRecord(db, requestId)?.purpose
    return purpose !== undefined && purpose !== 'status'
  })
  return id ? { answersRequest: id } : {}
}

/** Who sent a request: this Orca's own bot, or a sender on a paired computer (either side of the
 *  pairing). That bot is no bot of this Orca's, so only its name is kept, beside its computer. */
export function botRequestSender(
  bot: Pick<Bot, 'id' | 'name'> | null,
  paired: PairedSender | undefined
): Pick<BotRequestRecord, 'fromBotId' | 'fromBotName' | 'fromPairedComputer'> {
  if (paired) {
    return { fromBotId: null, fromBotName: paired.botName, fromPairedComputer: paired.computer }
  }
  return {
    fromBotId: bot?.id ?? null,
    fromBotName: bot?.name ?? null
  }
}
