// `bots.chats.own`: each bot's own side chats as its row's line reads them, one read for every bot on
// the host (or the bots a notice named), so a folded row learns which panes are its chats without
// reading its chats tree.
import type { BotRowLineChat } from '../../shared/bots/bot-row-line'
import { buildBotChatBase, readBotChatInputs } from './bot-chat-tree-base'
import type { BotChatTreeHost } from './bot-chat-tree-host'
import { isBotOwnChat } from './bot-own-chat'

/** Bot id to its open side chats, Home and threads left out (the line names those its own way). */
export async function readBotOwnChatPanes(
  host: BotChatTreeHost,
  botIds?: readonly string[]
): Promise<Record<string, BotRowLineChat[]>> {
  const store = await host.sessionRecords()
  if (!store) {
    return {}
  }
  const db = host.db()
  const byBot: Record<string, BotRowLineChat[]> = {}
  const named = botIds ? new Set(botIds) : null
  for (const bot of host.bots()) {
    if (named && !named.has(bot.id)) {
      continue
    }
    const inputs = readBotChatInputs(host, bot)
    const build = host.index
      ? host.index.base(bot, inputs)
      : buildBotChatBase(
          { db, backgroundRuns: host.backgroundRuns },
          store,
          inputs,
          store.listRecords()
        )
    const threads = new Set(inputs.links.map((link) => build.rootOf(link.sessionId)))
    // The chats tree lists a Dispatch worker in the home as a side chat; the line counts it as a worker.
    const own = [...build.chats.values()].filter((chat) => {
      const record = store.getRecord(build.sessionOfChat.get(chat.chatId) ?? chat.chatId)
      return (
        chat.origin === 'side' &&
        !chat.closed &&
        !threads.has(chat.chatId) &&
        record !== null &&
        isBotOwnChat(record, db, store)
      )
    })
    if (own.length === 0) {
      continue
    }
    const tabs = await host.chatTabs(inputs.workspaceId).catch(() => [])
    const tabTitles = new Map(
      tabs.flatMap((tab) => (tab.title ? [[build.rootOf(tab.sessionId), tab.title] as const] : []))
    )
    byBot[bot.id] = own.map((chat) => ({
      paneKey: chat.paneKey,
      title: tabTitles.get(chat.chatId) || chat.title
    }))
  }
  return byBot
}
