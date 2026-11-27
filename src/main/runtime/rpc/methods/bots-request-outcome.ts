// How a bot request a card in the owner's chat names has ended, and its answer, from Orca's record.
import { BotRequestOutcomeParams } from '../../../../shared/rpc-contract/bots-look-around-params'
import type { BotRequestCardReading } from '../../../../shared/bots/bot-request-card'
import { parseOrcaSessionAddress } from '../../../../shared/agent-session/identity/orca-session-address'
import { defineMethod, InvalidArgumentError } from '../core'
import { isBotAnswerTo } from './orchestration/messaging/bot-request-outcome'
import { readClientAskOutcome } from './orchestration/messaging/client-ask-card'

export const BOT_REQUEST_OUTCOME_METHOD = defineMethod({
  name: 'bots.request.outcome',
  permission: 'workspace',
  params: BotRequestOutcomeParams,
  handler: ({ messageId, onClient }, context): BotRequestCardReading => {
    const db = context.runtime.getOrchestrationDb()
    // Any window showing the asking chat reads it: what it says is that chat's own mail.
    if (onClient) {
      return readClientAskOutcome(db, messageId)
    }
    // People's paired windows and phones read it as they read that chat; an agent over a device's pairing does not.
    if (context.caller?.kind === 'paired-device' && context.caller.agent) {
      throw new InvalidArgumentError('Bot requests are read in Orca.')
    }
    const request = db.getBotRequest(messageId) ? db.getMessageById(messageId) : undefined
    if (!request) {
      return { outcome: null, answer: null, mailIds: [], chatId: null }
    }
    // The mail notice in the sender's chat only points at the mail; the card shows the answer itself,
    // and names the mail so the chat folds those notices into it.
    const replies = db.getThreadMessagesFor(request.thread_id ?? request.id, request.from_handle)
    const answer = replies.find((reply) => isBotAnswerTo(reply.payload, messageId))
    return {
      outcome: db.getBotRequestOutcome(messageId),
      answer: answer?.body ?? null,
      mailIds: replies.map((reply) => reply.id),
      // A request is mailed to the chat it runs in: the bot's Chat, a named one, or one made for it.
      chatId: parseOrcaSessionAddress(request.to_handle)
    }
  }
})
