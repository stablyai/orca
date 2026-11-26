// Look around over RPC: a look's `orca bot suggest`, the owner's Start and Dismiss, and the bot
// changing its own Look around when its owner asks in chat.
import {
  BotLookAroundSet,
  BotLookNow,
  BotSuggest,
  BotSuggestionAct,
  BotUpNextSeen,
  type BotLookAroundSetParams
} from '../../../../shared/rpc-contract/bots-look-around-params'
import {
  botLookAround,
  lookAroundSupported,
  LOOK_AROUND_EVERY_LABELS,
  type BotLookAround
} from '../../../../shared/bots/bot-look-around'
import type { Bot } from '../../../../shared/bot-types'
import { resolve, suggest } from '../../../bots/bot-look-around-state'
import { markUpNextSeen, upNextUnseenByBot } from '../../../bots/bot-look-around-seen'
import { botOfSession } from '../../../bots/bot-session-tabs'
import { runtimeLookAroundRunner } from '../../../bots/bot-look-around-runtime'
import { noteInChat } from '../../../bots/bot-chat-status-line'
import { defineMethod, InvalidArgumentError, type RpcContext } from '../core'

/** A session id names a chat only on its own host, so a paired client's claim names none. */
function callerOf(
  callerSessionId: string | undefined,
  context: Pick<RpcContext, 'pairedDeviceId'>
): string | undefined {
  return context.pairedDeviceId === undefined ? callerSessionId : undefined
}

function botById(context: RpcContext, botId: string): Bot {
  const bot = context.runtime.bots.list().find((entry) => entry.id === botId)
  if (!bot) {
    throw new InvalidArgumentError('bot_not_found')
  }
  return bot
}

/** What changed, in the words the chat line shows. */
export function lookAroundChangeText(before: BotLookAround, after: BotLookAround): string {
  if (before.on !== after.on) {
    return after.on ? 'Look around turned on' : 'Look around turned off'
  }
  const parts: string[] = []
  if (before.focus !== after.focus) {
    parts.push(after.focus ? `looks for: ${after.focus}` : 'looks for anything waiting on you')
  }
  if (before.every !== after.every || before.weekdaysOnly !== after.weekdaysOnly) {
    parts.push(
      `${LOOK_AROUND_EVERY_LABELS[after.every]}${after.weekdaysOnly ? ', weekdays' : ', every day'}`
    )
  }
  return parts.length > 0 ? `Look around updated: ${parts.join('; ')}` : 'Look around unchanged'
}

async function setLookAround(params: BotLookAroundSetParams, context: RpcContext) {
  const { runtime } = context
  runtime.bots.assertEnabled()
  const caller = callerOf(params.callerSessionId, context)
  // A look itself only reads, so it can't widen or turn off what it is.
  if (caller && runtime.lookAround.botOfLook(caller)) {
    throw new InvalidArgumentError('Looking around can only read.')
  }
  const bot = params.botId
    ? botById(context, params.botId)
    : caller
      ? botOfSession(runtime.bots, caller)
      : null
  if (!bot) {
    throw new InvalidArgumentError('Name the bot with --bot, or run this from the bot’s chat.')
  }
  if (!lookAroundSupported(bot.agent)) {
    throw new InvalidArgumentError('Look around needs a Claude Code or Codex bot.')
  }
  const { on, every, weekdaysOnly, focus } = params
  // Read as saved, inside the update queue, so an owner's edit in Settings is not undone.
  let before = botLookAround(bot)
  const saved = await runtime.bots.update(bot.id, (current) => {
    before = botLookAround(current)
    return { lookAround: { on, every, weekdaysOnly, focus } }
  })
  const change = lookAroundChangeText(before, botLookAround(saved))
  noteInChat(caller, change)
  return { bot: saved, change }
}

export const BOT_LOOK_AROUND_METHODS = [
  defineMethod({
    name: 'bots.suggest',
    permission: 'workspace',
    params: BotSuggest,
    handler: (params, context) => {
      const { runtime } = context
      const caller = callerOf(params.callerSessionId, context)
      const botId = caller ? runtime.lookAround.botOfLook(caller) : null
      if (!caller || !botId) {
        throw new InvalidArgumentError('Only a look-around run can suggest next steps.')
      }
      const { callerSessionId: _caller, ...input } = params
      const outcome = runtime.lookAround.update(botId, (state) => {
        const next = suggest(state, caller, input, Date.now())
        return { state: next.state, result: next.outcome }
      })
      if (!outcome.ok) {
        throw new InvalidArgumentError(outcome.refusal)
      }
      return { suggestion: { id: outcome.suggestion.id, title: outcome.suggestion.title } }
    }
  }),
  defineMethod({
    name: 'bots.suggestions.start',
    permission: 'workspace',
    params: BotSuggestionAct,
    handler: (params, context) => {
      botById(context, params.botId)
      const outcome = context.runtime.lookAround.update(params.botId, (state) => {
        const next = resolve(state, params.suggestionId, 'started', Date.now())
        return { state: next.state, result: next.outcome }
      })
      if (!outcome.ok) {
        throw new InvalidArgumentError(outcome.refusal)
      }
      // The client puts this in the bot's message box, unsent.
      return { ask: outcome.suggestion.ask }
    }
  }),
  defineMethod({
    name: 'bots.suggestions.dismiss',
    permission: 'workspace',
    params: BotSuggestionAct,
    handler: (params, context) => {
      botById(context, params.botId)
      const outcome = context.runtime.lookAround.update(params.botId, (state) => {
        const next = resolve(state, params.suggestionId, 'dismissed', Date.now())
        return { state: next.state, result: next.outcome }
      })
      if (!outcome.ok) {
        throw new InvalidArgumentError(outcome.refusal)
      }
      return { dismissed: true }
    }
  }),
  defineMethod({
    name: 'bots.lookAround.lookNow',
    permission: 'workspace',
    params: BotLookNow,
    handler: (params, context) => {
      context.runtime.bots.assertEnabled()
      const outcome = runtimeLookAroundRunner(context.runtime).lookNow(params.botId)
      if ('refused' in outcome) {
        throw new InvalidArgumentError(`look_now_${outcome.refused}`)
      }
      return outcome
    }
  }),
  defineMethod({
    name: 'bots.upNext.unseen',
    permission: 'workspace',
    params: null,
    // Each bot's new Up next count, for its sidebar dot and Activity tab.
    handler: (_params, { runtime }) => ({
      unseen: upNextUnseenByBot(runtime.lookAround, runtime.bots.list(), Date.now())
    })
  }),
  defineMethod({
    name: 'bots.upNext.seen',
    permission: 'workspace',
    params: BotUpNextSeen,
    handler: (params, context) => {
      botById(context, params.botId)
      context.runtime.lookAround.update(params.botId, (state) => ({
        state: markUpNextSeen(state, Date.now()),
        result: null
      }))
      return { seen: true }
    }
  }),
  defineMethod({
    name: 'bots.lookAround.set',
    permission: 'workspace',
    params: BotLookAroundSet,
    handler: setLookAround
  })
]
