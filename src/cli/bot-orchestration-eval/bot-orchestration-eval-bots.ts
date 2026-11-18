// The stand-in's other bots: `bot list` and mail to a bot, decided by the runtime's own rules
// (bot-request-policy, bot-request-view), so a bot is graded against refusals the real host makes.
// bot-eval-bot-mail-contract.test.ts holds the two to the same answers.
import { RuntimeClientError } from '../runtime/connection/types'
import {
  botOfAddress,
  botRosterFields,
  parseBotAddress,
  soulSpecialty,
  type BotRosterEntry
} from '../../shared/bot-roster'
import type { BotRequestAsker } from '../../shared/bots/bot-acts-for'
import {
  BOT_REQUEST_TYPE_REFUSAL,
  botNotFound,
  botRequestRefusal,
  isBotRequestPurpose,
  type BotRequestPurpose
} from '../../main/bots/bot-request-policy'
import {
  botAnswerView,
  botRequestSentNext,
  botRequestUnansweredText,
  botRequestView,
  type BotRequestRecord
} from '../../main/bots/bot-request-view'
import { EVAL_BOT, type EvalHostState } from '../bot-automation-eval/bot-automation-eval-host'
import { OWNER_SLACK_ID } from '../bot-automation-eval/bot-automation-eval-slack'
import type { StandInIo } from './bot-orchestration-eval-orca'
import type { StandInMessage } from './bot-orchestration-eval-mail'

/** Another bot as the stand-in keeps it. */
export type StandInBot = EvalHostState['bots'][number]

/** Who this turn is for, as Orca recorded the message that started it: the owner in their own Chat,
 *  else the person (the owner too) the cloud stamped on the thread's message, or whom the waking
 *  request was for. */
export function evalAskers(state: EvalHostState): BotRequestAsker[] {
  if (state.actingOnRequest) {
    return state.actingOnRequest.askers
  }
  const { conversation } = state
  if (!conversation) {
    return [{ kind: 'owner' }]
  }
  const asker = conversation.asker ?? OWNER_SLACK_ID
  const dm = conversation.slack?.channel.startsWith('D')
  return [
    {
      kind: 'person',
      source: conversation.source,
      userId: asker,
      ...(conversation.askerName ? { name: conversation.askerName } : {}),
      workspaceId: EVAL_BOT.slack.teamId,
      role: asker === OWNER_SLACK_ID ? 'owner' : 'member',
      placeKind: dm ? 'direct_message' : 'public_channel'
    }
  ]
}

function record(state: EvalHostState, target: StandInBot, purpose: BotRequestPurpose) {
  const slack = state.conversation?.slack
  const value: BotRequestRecord = {
    fromBotId: EVAL_BOT.id,
    fromBotName: EVAL_BOT.name,
    toBotId: target.id,
    toBotName: target.name,
    purpose,
    depth: (state.actingOnRequest?.depth ?? 0) + 1,
    askers: evalAskers(state),
    request: null,
    conversation:
      state.conversation?.source === 'slack' && slack
        ? {
            source: 'slack',
            externalId: `${EVAL_BOT.slack.teamId}:${slack.channel}:${slack.thread}:UEVAL`
          }
        : null
  }
  return value
}

/** `orca bot list`, as bots.roster answers it. */
export function roster(state: EvalHostState): { bots: BotRosterEntry[] } {
  return {
    bots: state.bots.map((bot) => ({
      ...botRosterFields({ ...bot, paused: bot.paused ?? false }),
      specialty: soulSpecialty(state.souls?.[bot.id] ?? null),
      ...(bot.id === EVAL_BOT.id ? { self: true as const } : {})
    }))
  }
}

/** Mail to `bot:<name>`, checked and stored as the runtime does; the receipt is the runtime's. */
export function sendToBot(
  state: EvalHostState,
  params: Record<string, unknown>
): { receipt: unknown; verdict: unknown } {
  const name = parseBotAddress(String(params.to ?? ''))
  const bots = state.bots
  const target = name ? botOfAddress(bots, name) : null
  const refuse = (refusal: { code: string; message: string }): never => {
    throw new RuntimeClientError(refusal.code, refusal.message)
  }
  if (!target) {
    return refuse(botNotFound(name ?? '', bots))
  }
  if (!params.subject) {
    throw new RuntimeClientError('invalid_argument', 'Missing --subject')
  }
  const purpose = typeof params.type === 'string' ? params.type : undefined
  const refusal = botRequestRefusal({
    enabled: true,
    target: { ...target, paused: target.paused ?? false },
    senderBotId: EVAL_BOT.id,
    // The eval bot sends from its Home Chat, where its own name lands too.
    toOtherChat: false,
    type: purpose
  })
  if (refusal || !isBotRequestPurpose(purpose)) {
    return refuse(refusal ?? BOT_REQUEST_TYPE_REFUSAL)
  }
  const sent = (state.botRequests ??= [])
  // Only the same send again is a duplicate: same bot, kind and text.
  const earlier = sent.find(
    (entry) =>
      entry.toBotId === target.id &&
      entry.purpose === purpose &&
      entry.message.subject === String(params.subject) &&
      entry.message.body === String(params.body ?? '')
  )
  if (purpose !== 'status' && earlier) {
    return {
      receipt: {
        message: earlier.message,
        duplicate: true,
        next: `${target.name} already has this request, so no second message was sent.`
      },
      verdict: { delivered: false, error: 'duplicate', bot: target.name }
    }
  }
  const messageId = `msg_bot_${sent.length + 1}`
  const value = record(state, target, purpose)
  const message: StandInMessage = {
    id: messageId,
    from_handle: `orca_session_id:${EVAL_BOT.id}`,
    to_handle: `orca_session_id:${target.id}`,
    type: purpose,
    subject: String(params.subject),
    body: String(params.body ?? ''),
    payload: JSON.stringify({ botRequest: botRequestView(value, messageId) })
  }
  sent.push({ toBotId: target.id, purpose, message })
  return {
    receipt: { message, next: botRequestSentNext(value) },
    verdict: { delivered: true, bot: target.name, purpose }
  }
}

/** A bot request in the bot's own mail, as Orca writes it for the receiving bot. */
export function botRequestMail(input: {
  id: string
  from: StandInBot
  state: EvalHostState
  purpose: 'handoff' | 'question'
  subject: string
  body: string
}): StandInMessage {
  const value: BotRequestRecord = {
    ...record(input.state, { ...EVAL_BOT, agent: 'claude' }, input.purpose),
    fromBotId: input.from.id,
    fromBotName: input.from.name
  }
  return {
    id: input.id,
    from_handle: `orca_session_id:${input.from.id}`,
    to_handle: `orca_session_id:${EVAL_BOT.id}`,
    type: input.purpose,
    subject: input.subject,
    body: input.body,
    payload: JSON.stringify({ botRequest: botRequestView(value, input.id) })
  }
}

/** Another bot's answer to a request this bot sent it, as Orca writes it for the sender. */
export function botAnswerMail(input: {
  id: string
  from: StandInBot
  state: EvalHostState
  purpose: 'handoff' | 'question'
  inReplyTo: string
  subject: string
  body: string
}): StandInMessage {
  return {
    id: input.id,
    from_handle: `orca_session_id:${input.from.id}`,
    to_handle: `orca_session_id:${EVAL_BOT.id}`,
    type: 'status',
    subject: `Re: ${input.subject}`,
    body: input.body,
    thread_id: input.inReplyTo,
    payload: JSON.stringify({
      botAnswer: botAnswerView(record(input.state, input.from, input.purpose), false)
    })
  }
}

/** Orca's word that a request ended with no answer, as the sender reads it. */
export function botUnansweredMail(input: {
  id: string
  from: StandInBot
  state: EvalHostState
  purpose: 'handoff' | 'question'
  inReplyTo: string
  subject: string
}): StandInMessage {
  return {
    id: input.id,
    from_handle: `orca_session_id:${input.from.id}`,
    to_handle: `orca_session_id:${EVAL_BOT.id}`,
    type: 'status',
    subject: `Re: ${input.subject}`,
    body: botRequestUnansweredText(record(input.state, input.from, input.purpose), 'ended'),
    thread_id: input.inReplyTo
  }
}

/** Answers a bot method, or undefined to leave it to the rest of the stand-in. */
export function serveBots(
  state: EvalHostState,
  method: string,
  params: Record<string, unknown>,
  io: StandInIo
): unknown {
  if (method === 'bots.roster') {
    return roster(state)
  }
  if (method !== 'orchestration.send' || parseBotAddress(String(params.to ?? '')) === null) {
    return undefined
  }
  try {
    const { receipt, verdict } = sendToBot(state, params)
    io.record({ kind: 'write', method, params, result: verdict })
    io.save(state)
    return receipt
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    io.record({
      kind: 'write',
      method,
      params,
      result: { delivered: false, error: reason }
    })
    throw error
  }
}
