// `bots.endChat`: end one of a bot's side chats, for the owner's window, phone or terminal, or for a
// chat of the same bot on a turn its owner typed. A declared caller chat is a workflow guard, not a
// credential: one this host can't resolve to such a chat is refused.
import {
  BotChatEndParams,
  type BotChatEndRefusal,
  type BotChatEndResult
} from '../../../../shared/bots/bot-chat-end'
import type { Bot } from '../../../../shared/bot-types'
import { requireStructuredHost } from '../../../bots/bot-chat-session'
import { endBotChat, type BotChatEndDeps } from '../../../bots/chat-end/bot-chat-end'
import { botChatEndObligations } from '../../../bots/chat-end/bot-chat-end-obligations'
import { runBotChatEndOp } from '../../../bots/chat-end/bot-chat-end-ops'
import {
  canonicalBotChatId,
  lookUpBotChatEndTarget
} from '../../../bots/chat-end/bot-chat-end-target'
import { isAgentRpcCaller } from '../callers/rpc-caller-identity'
import { defineMethod, type RpcContext } from '../core'
import { namedOrCallerBot } from './bots-caller-bot'
import { ownerTypedLatest } from './bots-owner-turn'

/** Refused before anything is read about the target: who is asking, and on whose turn. */
async function callerRefusal(
  params: BotChatEndParams,
  context: RpcContext,
  bot: Bot,
  caller: string | undefined,
  callerBot: Bot | null
): Promise<BotChatEndRefusal | null> {
  const agent = isAgentRpcCaller(context.caller)
  if (params.intent === 'x') {
    return agent ? { kind: 'not-owner' } : null
  }
  if (!agent) {
    return null
  }
  if (context.caller?.kind === 'paired-device') {
    return { kind: 'not-owner' }
  }
  if (caller === undefined) {
    return null
  }
  if (!callerBot) {
    return { kind: 'not-owner' }
  }
  if (callerBot.id !== bot.id) {
    return { kind: 'other-bot' }
  }
  if (context.runtime.getExternalConversationSeam()?.deliveredTurn(caller)) {
    return { kind: 'outside-turn' }
  }
  return (await ownerTypedLatest(context.runtime, caller)) ? null : { kind: 'not-owner' }
}

/** The end op wired to this runtime, as `bots.endChat` runs it. */
export async function runtimeBotChatEndDeps(
  runtime: RpcContext['runtime'],
  bot: Bot,
  chat: string,
  caller: string | undefined
): Promise<BotChatEndDeps> {
  const host = await requireStructuredHost(runtime)
  const seam = () => runtime.getExternalConversationSeam()
  const store = () => runtime.requireStore()
  return {
    host,
    runtime,
    lookUp: () => {
      const found = lookUpBotChatEndTarget(
        {
          host,
          bots: runtime.bots.list(),
          backgroundRuns: runtime.lookAround,
          linkSource: (ids) => seam()?.chatLinkSource(ids) ?? null
        },
        bot,
        chat
      )
      return found.kind !== 'refused' && caller && found.target.lineage.includes(caller)
        ? { kind: 'refused', refusal: { kind: 'self' } }
        : found
    },
    owes: (lineage) =>
      botChatEndObligations(
        {
          db: runtime.getOrchestrationDb(),
          automations: () => store().listAutomations?.() ?? [],
          activeRunsInto: (ids) => store().listActiveAutomationRunsInto?.(ids) ?? [],
          deliveryPending: (id) => seam()?.deliveredTurn(id) ?? false
        },
        bot.id,
        lineage
      ),
    redrive: (sessionId) => runtime.redriveStructuredSessionMail(sessionId)
  }
}

async function endChatFor(
  params: BotChatEndParams,
  context: RpcContext,
  bot: Bot,
  caller: string | undefined
): Promise<BotChatEndResult> {
  return endBotChat(await runtimeBotChatEndDeps(context.runtime, bot, params.chat, caller), {
    intent: params.intent,
    sessionId: params.chat.replace(/^chat:/, ''),
    ...(params.showing ? { showing: params.showing } : {})
  })
}

export const BOT_END_CHAT_METHOD = defineMethod({
  name: 'bots.endChat',
  permission: 'workspace',
  params: BotChatEndParams,
  handler: async (params, context): Promise<BotChatEndResult> => {
    context.runtime.bots.assertEnabled()
    const { bot, caller, callerBot } = namedOrCallerBot(params, context)
    // Every request, a repeat included, answers to who asks now; a repeat never borrows a policy.
    const refusal = await callerRefusal(params, context, bot, caller, callerBot)
    if (refusal) {
      return { outcome: 'refused', refusal }
    }
    // The op is this caller (all of its identity) ending this chat (by lineage root) this way.
    const key = JSON.stringify([
      context.caller ?? null,
      caller === undefined ? null : canonicalBotChatId(caller),
      bot.id,
      canonicalBotChatId(params.chat),
      params.intent,
      params.showing ?? null
    ])
    return runBotChatEndOp({ opId: params.opId, key, botId: bot.id, now: Date.now }, () =>
      endChatFor(params, context, bot, caller)
    )
  }
})
