/** How a bot request ends, back to the bot that sent it: the answer's reply carries what to do with it,
 * a post where the asker asked is noted so the answer is never passed on twice, and a request that
 * ends with no answer, or is dropped unread, wakes the sender to tell the asker. */

import type { MessageRow } from '../../../../orchestration/db/orchestration-records'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import {
  botAnswerView,
  botRequestAnswerRef,
  botRequestSenderName
} from '../../../../../bots/bot-request-view'
import { ensureSenderRecords, tellSender } from './bot-request-sender-notice'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { awaitsAnswer } from '../../../../../bots/bot-request-policy'
import { noteBotRequestFailureReason, reconcileBotRequestTakes } from './bot-request-take-reconcile'
import { botOfSession } from '../../../../../bots/bot-session-tabs'
import { readBotTurn } from './bot-recipient'
import { botRequestRecord } from './bot-request-record'
import { getStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { TurnEndedVerdict } from '../../../../../native-chat/agent-session-wire/structured-agent-session-turn-context'
import type { StructuredAgentSessionRequestFailure } from '../../../../../native-chat/agent-session-wire/observations/structured-agent-session-request-failures'
import { ORCA_SESSION_ADDRESS_PREFIX } from '../../../../../../shared/agent-session/identity/orca-session-address-prefix'
import { readChatRequestError } from '../../../../orchestration/workers/turn-stops/chat-request-error-read'

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

/** After a post: when it went where the request it answers was asked, the request is answered there.
 *  Those are the turn's own and the ones the chat holds undecided (read by `check`); one already
 *  decided stays decided, as only the chat's current work can be told apart by thread. */
export async function noteBotRequestPost(
  runtime: OrcaRuntimeService,
  sessionId: string,
  ref: string | undefined
): Promise<void> {
  if (!ref) {
    return
  }
  const db = runtime.getOrchestrationDb()
  const { turn } = await readBotTurn(runtime, db, sessionId)
  // A message ref in the thread starts with the thread's ref.
  const askedHere = (requestId: string) => {
    const record = botRequestRecord(db, requestId)
    const answerRef = record ? botRequestAnswerRef(record) : null
    return answerRef !== null && `${ref}:`.startsWith(`${answerRef}:`)
  }
  const held = db.listOpenBotRequestTakes(sessionId).map((take) => take.message_id)
  for (const requestId of new Set([...turn.requestIds, ...held])) {
    if (askedHere(requestId)) {
      db.recordBotRequestOutcome(requestId, 'posted')
    }
  }
}

/** A turn on a request ended: with no answer and no work still running for it, the sender is told.
 *  A failed turn is told by `settleBotRequestFailure`, which knows why. */
export async function settleBotRequestTurn(
  runtime: OrcaRuntimeService,
  sessionId: string,
  ended?: TurnEndedVerdict
): Promise<void> {
  if (ended?.outcome !== 'failure') {
    await settleBotRequests(runtime, sessionId, 'ended')
  }
}

/** A bot's request failed: the sender hears why, in the words its chat and worker escalations show. */
export async function settleBotRequestFailure(
  runtime: OrcaRuntimeService,
  failure: StructuredAgentSessionRequestFailure
): Promise<void> {
  if (!botOfSession(runtime.bots, failure.sessionId)) {
    return
  }
  const error = await readChatRequestError(failure)
  noteBotRequestFailureReason(runtime, failure.sessionId, error?.text)
  const why = (await continuesAfterUsageLimit(failure.sessionId)) ? 'failed-continues' : 'failed'
  await settleBotRequests(runtime, failure.sessionId, why, error?.text)
  // Its rest may already have been read without the reason; a decided request stays decided.
  await reconcileBotRequestTakes(runtime, failure.sessionId)
}

async function settleBotRequests(
  runtime: OrcaRuntimeService,
  sessionId: string,
  why: 'ended' | 'failed' | 'failed-continues',
  reason?: string
): Promise<void> {
  // Every chat's turn ends here; only a bot's can be on a request.
  if (!botOfSession(runtime.bots, sessionId)) {
    return
  }
  const db = runtime.getOrchestrationDb()
  const { turn } = await readBotTurn(runtime, db, sessionId)
  // Requests under the new rule are decided by the chat's rest instead.
  const open = turn.requestIds.filter(
    (id) => db.getBotRequestOutcome(id) === null && db.getBotRequest(id)?.debt_rule !== 1
  )
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
      tellSender(runtime, db, message, {
        outcome: 'unanswered',
        why,
        ...(reason ? { reason } : {})
      })
    }
  }
}

/** Orca sends the chat "continue" once the limit resets, which runs the failed turn's work again.
 *  Nothing else reruns a failed turn on its own: Resume releases only the mail queued behind it. */
async function continuesAfterUsageLimit(sessionId: string): Promise<boolean> {
  const host = getStructuredAgentSessionHost()
  return (await host?.readUsageLimitContinue(sessionId))?.state === 'scheduled'
}

/** Requests a bot will never read: it was paused or deleted, or its Chat replaced. Each is released
 *  to its chat as read, and its sender told as that chat's take would be, retried until told. */
export async function dropUnreadBotRequests(
  runtime: OrcaRuntimeService,
  botId: string,
  why: 'paused' | 'deleted' | 'new-chat',
  /** Only those mailed to this conversation (the Chat a new one replaced). */
  onlyTo?: string
): Promise<void> {
  try {
    const db = runtime.getOrchestrationDb()
    const holders = new Set<string>()
    for (const { message } of db.listUnreadBotRequests(botId)) {
      const holder = message.to_handle.startsWith(ORCA_SESSION_ADDRESS_PREFIX)
        ? message.to_handle.slice(ORCA_SESSION_ADDRESS_PREFIX.length)
        : message.to_handle
      if (
        (!onlyTo || message.to_handle.endsWith(onlyTo)) &&
        db.releaseUnreadBotRequest(message.id, holder, why)
      ) {
        holders.add(holder)
      }
    }
    await Promise.all([...holders].map((holder) => reconcileBotRequestTakes(runtime, holder)))
  } catch (error) {
    // The change itself stands; only the senders go untold.
    console.warn('[bots] could not tell senders of dropped bot requests', error)
  }
}
