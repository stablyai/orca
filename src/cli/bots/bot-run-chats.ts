// `orca bot run-chats`: how many of a bot's automation-run chats a check would close now and what
// keeps the rest, as counts; `set` turns that closing on or off.
import {
  RUN_CHAT_KEEP_REASONS,
  type BotRunChatsPreview
} from '../../shared/bots/bot-run-chat-close'
import type { CommandHandler } from '../dispatch/dispatch'
import { getOptionalStringFlag } from '../arguments/flags'
import { printResult } from '../output/command-result-output'
import { RuntimeClientError } from '../runtime/connection/types'
import { callerChat } from '../automations/automation-caller-chat'
import { callBots, findBot } from './bot'

type RunChatsResult = BotRunChatsPreview & { botId: string }

/** Counts only: the chats' titles are in --json. */
export function formatRunChats(preview: BotRunChatsPreview): string {
  const runChats = preview.close.length + preview.keep.length
  const owning = preview.close.filter((chat) => chat.items.length > 0).length
  const reasons = RUN_CHAT_KEEP_REASONS.flatMap((reason) => {
    const count = preview.keep.filter((chat) => chat.keep.includes(reason)).length
    return count > 0 ? [`  ${reason}: ${count}`] : []
  })
  return [
    `${preview.bot}: closing ended run chats is ${preview.on ? 'on' : 'off'}.`,
    `Open chats: ${preview.open} (${runChats} opened by a run, ${preview.notRunChats} not${preview.unreadable > 0 ? `, ${preview.unreadable} could not be read and stay open` : ''}).`,
    `Would close now: ${preview.close.length}${owning > 0 ? ` (${owning} own items; their mail then reaches the Home Chat)` : ''}.`,
    `Would keep: ${preview.keep.length}${reasons.length > 0 ? ', by reason (a chat can have several):' : '.'}`,
    ...reasons,
    ...(preview.itemsCut ? ['Items listed are one page; a chat can own more than it shows.'] : [])
  ].join('\n')
}

export const BOT_RUN_CHATS_HANDLERS: Record<string, CommandHandler> = {
  'bot run-chats': async ({ flags, client, json }) => {
    const selector = getOptionalStringFlag(flags, 'bot')
    const botId = selector ? (await findBot(client, selector)).id : undefined
    const result = await callBots<RunChatsResult>(client, 'bots.runChats', {
      ...callerChat(),
      ...(botId ? { botId } : {})
    })
    printResult(result, json, formatRunChats)
  },
  'bot run-chats set': async ({ flags, client, json }) => {
    const on = flags.get('on') === true
    if (on === (flags.get('off') === true)) {
      throw new RuntimeClientError('invalid_argument', 'Pass --on or --off')
    }
    const selector = getOptionalStringFlag(flags, 'bot')
    if (!selector) {
      throw new RuntimeClientError('invalid_argument', 'Name the bot with --bot')
    }
    const bot = await findBot(client, selector)
    const result = await callBots<unknown>(client, 'bots.update', {
      botId: bot.id,
      updates: { closeEndedRuns: on }
    })
    printResult(result, json, () =>
      on
        ? `${bot.name} now closes its ended run chats: those that piled up now, then 10 minutes after each run.`
        : `${bot.name} no longer closes its ended run chats; closed ones stay in history.`
    )
  }
}
