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
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { botOfSession } from '../../../../../bots/bot-session-tabs'
import { runtimeBotGroups } from '../../../../../bots/bot-group-runtime'
import { awaitsAnswer } from '../../../../../bots/bot-request-policy'
import { readBotTurn } from './bot-recipient'
import { botRequestRecord } from './bot-request-record'
import { ensureSenderRecords, tellSender } from './bot-request-sender-notice'
import { noteBotQuestionFailure } from './bot-question-notices'
import { runLifecycleWriteTransaction } from '../../../../orchestration/db/lifecycle-write-transaction-runner'
import { retireCoordinatorChatRuns } from '../../../../orchestration/db/runs/retired-chat-runs'
import {
  stampQuestionTakes,
  type MailTaker
} from '../../../../orchestration/db/messages/mail-taker'
import { getStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { TurnEndedVerdict } from '../../../../../native-chat/agent-session-wire/structured-agent-session-turn-context'
import type { StructuredAgentSessionRequestFailure } from '../../../../../native-chat/agent-session-wire/observations/structured-agent-session-request-failures'
import { readChatRequestError } from '../../../../orchestration/workers/turn-stops/chat-request-error-read'
import { redactFailure } from '../../../../orchestration/workers/turn-stops/worker-turn-stop-wording'

const ACTIVE_DISPATCH = new Set(['pending', 'dispatched'])

/** The payload a reply to a request carries: what the sender does with the answer. */
export function botAnswerPayload(
  db: OrchestrationDb,
  original: MessageRow,
  shownInRoom = false
): string | undefined {
  const answer = botAnswerOf(db, original, shownInRoom).botAnswer
  return answer
    ? JSON.stringify({ requestId: answer.requestId, botAnswer: answer.view })
    : undefined
}

/** The answer a reply to a request is, recorded once; empty for a reply to other mail. */
export function botAnswerOf(
  db: OrchestrationDb,
  original: MessageRow,
  shownInRoom = false
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
  return {
    botAnswer: { requestId: original.id, view: botAnswerView(record, answer.posted, shownInRoom) }
  }
}

/** The room turn a group member's answer to a request shows on, read before the reply is written;
 *  null outside a group room, or where the room cannot show it. Never fails the reply. */
export async function groupAnswerTurn(
  runtime: OrcaRuntimeService,
  original: MessageRow,
  callerSessionId: string | undefined,
  body: string
): Promise<string | null> {
  const record = botRequestRecord(runtime.getOrchestrationDb(), original.id)
  const group = record?.group
  if (!group || callerSessionId !== group.targetSessionId || !awaitsAnswer(record.purpose)) {
    return null
  }
  return runtimeBotGroups(runtime)
    .answerTurn(callerSessionId, body)
    .catch((error: unknown) => {
      console.warn('[bot-groups] could not find the room turn for an answer', error)
      return null
    })
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
  const why = (await continuesAfterUsageLimit(failure.sessionId)) ? 'failed-continues' : 'failed'
  // The reason is mailed to other agents and paired computers, so redact it as worker escalations do.
  const reason = error ? redactFailure(error.text) : undefined
  noteBotQuestionFailure(failure.sessionId, { requestId: failure.id, why, reason })
  await settleBotRequests(runtime, failure.sessionId, why, reason)
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
  // Questions are decided by the question reconciler (mailbox/questions), from who took them.
  const open = turn.requestIds.filter(
    (id) => db.getBotRequest(id)?.purpose === 'handoff' && db.getBotRequestOutcome(id) === null
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
      tellSender(runtime, db, message, 'unanswered', why, reason)
    }
  }
}

/** Orca sends the chat "continue" once the limit resets, which runs the failed turn's work again.
 *  Nothing else reruns a failed turn on its own: Resume releases only the mail queued behind it. */
async function continuesAfterUsageLimit(sessionId: string): Promise<boolean> {
  const host = getStructuredAgentSessionHost()
  return (await host?.readUsageLimitContinue(sessionId))?.state === 'scheduled'
}

/** Requests a bot will never read: it was paused or deleted, or its Chat replaced. */
export async function dropUnreadBotRequests(
  runtime: OrcaRuntimeService,
  botId: string,
  why: 'paused' | 'deleted' | 'new-chat' | 'chat-deleted',
  /** Only those mailed to this conversation (the Chat a new one replaced, or a deleted chat). */
  onlyTo?: string
): Promise<void> {
  try {
    const db = runtime.getOrchestrationDb()
    const unread = db
      .listUnreadBotRequests(botId)
      .filter(({ message }) => !onlyTo || message.to_handle.endsWith(onlyTo))
    // A question is dropped as a take: the reconciler tells its asker, and retries an asker it
    // can't verify yet. One being handed to the chat now is taken unread; a handover that still
    // reaches the chat reads it, and a later answer still lands.
    for (const { request, message } of unread) {
      if (request.purpose === 'question') {
        runLifecycleWriteTransaction(db.db, 'drop_bot_question', () => {
          const dropped: MailTaker = { kind: 'dropped', why }
          if (db.getStructuredMailSendsForMessages([message.id]).length === 0) {
            db.markAsRead([message.id], dropped)
          } else {
            stampQuestionTakes(db, [message.id], dropped)
          }
        })
      }
    }
    if (why === 'chat-deleted' && onlyTo) {
      // A replaced Chat's Runs are retired where it is closed (bot-chat-replacement.ts).
      retireCoordinatorChatRuns(db, onlyTo)
    }
    const dropped = unread
      .filter(({ request }) => request.purpose !== 'question')
      .map(({ message }) => message)
    await ensureSenderRecords(runtime, dropped)
    for (const message of dropped) {
      // Read in the same write as its outcome and notice, so the drop is never half done.
      tellSender(runtime, db, message, 'dropped', why, undefined, () =>
        db.markAsRead([message.id], { kind: 'dropped', why })
      )
    }
  } catch (error) {
    // The change itself stands; only the senders go untold.
    console.warn('[bots] could not tell senders of dropped bot requests', error)
  }
  // A paused or deleted bot's chat no longer takes mail: a question it read waits on nothing now.
  runtime.questionReconciler?.decideAll()
}
