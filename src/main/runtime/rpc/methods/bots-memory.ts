// A bot's MEMORY.md as Settings and the bot's own commands change it: every change goes through the
// host's memory record, so it lands in history and no turn end undoes it.
import {
  addBotMemoryFact,
  botMemoryChange,
  botMemoryDate,
  editBotMemoryFact,
  parseBotMemoryFacts,
  uniqueBotMemoryLines
} from '../../../../shared/bot-memory-lines'
import {
  BotChat,
  BotMemoryEdit,
  BotMemoryForget,
  BotMemoryUndo
} from '../../../../shared/rpc-contract/bots-params'
import type {
  BotMemoryHistoryRow,
  BotMemoryHistoryView
} from '../../../../shared/bots/bot-memory-history'
import { botHomeFolder } from '../../../bots/bot-home'
import { namedOrCallerBot } from './bots-caller-bot'
import { readBotChats } from './bots-chats'
import { defineMethod, InvalidArgumentError } from '../core'

// Requests waiting on one history read share one view: a stalled disk holds no work per request.
const historyViews = new WeakMap<
  Promise<readonly BotMemoryHistoryRow[]>,
  Promise<BotMemoryHistoryView[]>
>()

async function historyView(
  runtime: Parameters<typeof readBotChats>[0],
  bot: Parameters<typeof readBotChats>[1],
  listed: Promise<readonly BotMemoryHistoryRow[]>
): Promise<BotMemoryHistoryView[]> {
  const rows = await listed
  const titles = new Map(
    (await readBotChats(runtime, bot, null, true)).map((chat) => [chat.id, chat.title])
  )
  return rows.map((row) => ({
    ...row,
    change: {
      added: uniqueBotMemoryLines(row.change.added),
      removed: uniqueBotMemoryLines(row.change.removed)
    },
    chat: 'sessionId' in row.by ? (titles.get(row.by.sessionId) ?? null) : null
  }))
}

export const BOT_MEMORY_METHODS = [
  defineMethod({
    // The one way a fact leaves a bot's MEMORY.md: a turn end puts back any other removal.
    name: 'bots.memory.forget',
    permission: 'workspace',
    params: BotMemoryForget,
    handler: async (params, context) => {
      context.runtime.bots.assertEnabled()
      const { bot, caller } = namedOrCallerBot(params, context)
      return {
        forgot: await context.runtime.bots.memory.forget(
          bot.id,
          botHomeFolder(bot),
          params.fact,
          caller ? { kind: 'bot', sessionId: caller } : { kind: 'owner' }
        )
      }
    }
  }),
  defineMethod({
    name: 'bots.memory.edit',
    permission: 'workspace',
    params: BotMemoryEdit,
    handler: async (params, context) => {
      context.runtime.bots.assertEnabled()
      const { bot } = namedOrCallerBot(params, context)
      await context.runtime.bots.memory.change(
        bot.id,
        botHomeFolder(bot),
        { kind: 'owner' },
        (file) => {
          if (params.fact === undefined) {
            return botMemoryChange(
              file,
              addBotMemoryFact(file, params.text, botMemoryDate(new Date()))
            )
          }
          const fact = parseBotMemoryFacts(file).find((entry) => entry.text === params.fact)
          if (!fact) {
            throw new InvalidArgumentError(
              'That memory changed meanwhile. Open it again to edit it.'
            )
          }
          return botMemoryChange(file, editBotMemoryFact(file, fact, params.text))
        }
      )
      return {}
    }
  }),
  defineMethod({
    name: 'bots.memory.history',
    permission: 'workspace',
    params: BotChat,
    handler: async (params, context) => {
      const { runtime } = context
      runtime.bots.assertEnabled()
      const { bot } = namedOrCallerBot(params, context)
      const listed = runtime.bots.memory.history(bot.id)
      let view = historyViews.get(listed)
      if (!view) {
        view = historyView(runtime, bot, listed)
        historyViews.set(listed, view)
      }
      return { rows: await view }
    }
  }),
  defineMethod({
    name: 'bots.memory.undo',
    permission: 'workspace',
    params: BotMemoryUndo,
    handler: async (params, context) => {
      context.runtime.bots.assertEnabled()
      const { bot } = namedOrCallerBot(params, context)
      return {
        undone: await context.runtime.bots.memory.undo(bot.id, botHomeFolder(bot), params.id)
      }
    }
  })
]
