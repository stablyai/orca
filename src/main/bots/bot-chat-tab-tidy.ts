// A bot's chat tabs that nobody needs any more close by themselves, the way a person's "x" closes a bot
// chat's tab: the chat keeps its history and its address, stays in the bot's Chats and Session History,
// and opens again from there. A request in a new chat opens a tab no one ever closes, so without this
// every finished or failed request stays in the bot's sidebar for good.
import type { Bot } from '../../shared/bot-types'
import type { BotChatTreeChat } from '../../shared/bots/bot-chat-tree'
import { isBotGroupMemberSession } from '../../shared/bots/bot-group'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'

/** How long a chat sits untouched (no turn, no mail, its tab not focused) before its tab closes. */
export const BOT_CHAT_TAB_IDLE_MS = 24 * 60 * 60 * 1000
/** Between passes. */
export const BOT_CHAT_TAB_TIDY_EVERY_MS = 60 * 60 * 1000
/** From the first tick to the first pass, so launch's own work goes first. */
export const BOT_CHAT_TAB_TIDY_FIRST_AFTER_MS = 10 * 60 * 1000

/** A chat tab in the bot's home, as the host lists it. */
export type BotChatTabTidyTab = {
  sessionId: string
  tabId: string
  /** In front of its tab group: what a person sees when they open the bot's home. */
  isActive: boolean
  isPinned?: true
}

export type BotChatTabTidyHost = {
  bots: () => readonly Pick<Bot, 'id' | 'folderWorkspaceId'>[]
  /** The bot's chats as its sidebar reads them, and the chat each session belongs to. */
  chats: (
    botId: string
  ) => Promise<{ chats: readonly BotChatTreeChat[]; rootOf: (sessionId: string) => string }>
  tabs: (workspaceId: string) => Promise<readonly BotChatTabTidyTab[]>
  /** Of these chats, the ones an open item of the bot's belongs to. */
  openItemChats: (botId: string, chatIds: readonly string[]) => Promise<ReadonlySet<string>>
  /** Read right before the close: no agent starting, nothing working or waiting on the owner, and
   *  no screen showing any of these sessions. */
  settled: (sessionIds: readonly string[]) => boolean
  /** When a person last focused the tab, from the saved layout; null when it never was or isn't known. */
  lastFocusedAt: (workspaceId: string, tab: BotChatTabTidyTab) => number | null
  /** Closes the tab as a person's "x" does; a bot chat keeps going without it. */
  closeTab: (workspaceId: string, tabId: string) => Promise<void>
  now: () => number
  warn: (message: string, error: unknown) => void
}

/** Chats whose tab may close: side chats and thread chats (never Home, a group room or an automation
 *  run), open in a tab, not ended, idle with no worker running or waiting, untouched for a day. */
export function botChatTabsDue(
  chats: readonly BotChatTreeChat[],
  now: number,
  idleMs: number = BOT_CHAT_TAB_IDLE_MS
): BotChatTreeChat[] {
  return chats.filter(
    (chat) =>
      chat.origin !== 'home' &&
      chat.origin !== 'automation' &&
      !chat.run &&
      !isBotGroupMemberSession(chat.chatId) &&
      !chat.closed &&
      chat.tab === true &&
      chat.live === 'idle' &&
      chat.runningTotal === 0 &&
      now - chat.lastActiveAt >= idleMs
  )
}

/** A tab a person keeps: pinned, in front, or focused within the idle window. */
export function botChatTabHeld(
  tab: BotChatTabTidyTab,
  lastFocusedAt: number | null,
  now: number,
  idleMs: number = BOT_CHAT_TAB_IDLE_MS
): boolean {
  return (
    tab.isPinned === true ||
    tab.isActive ||
    (lastFocusedAt !== null && now - lastFocusedAt < idleMs)
  )
}

/** One pass over every bot on this host; returns the chats whose tabs it closed. A bot or chat that
 *  fails to read or close is skipped, never the whole pass. */
export async function tidyBotChatTabs(host: BotChatTabTidyHost): Promise<string[]> {
  const closed: string[] = []
  for (const bot of host.bots()) {
    try {
      closed.push(...(await tidyOneBot(host, bot)))
    } catch (error) {
      host.warn('[bots] could not tidy chat tabs', error)
    }
  }
  return closed
}

async function tidyOneBot(
  host: BotChatTabTidyHost,
  bot: Pick<Bot, 'id' | 'folderWorkspaceId'>
): Promise<string[]> {
  const { chats, rootOf } = await host.chats(bot.id)
  const due = botChatTabsDue(chats, host.now())
  if (due.length === 0) {
    return []
  }
  const workspaceId = folderWorkspaceKey(bot.folderWorkspaceId)
  const owned = await host.openItemChats(
    bot.id,
    due.map((chat) => chat.chatId)
  )
  const tabs = await host.tabs(workspaceId)
  const closed: string[] = []
  for (const chat of due) {
    if (owned.has(chat.chatId)) {
      continue
    }
    const now = host.now()
    const chatTabs = tabs.filter((tab) => rootOf(tab.sessionId) === chat.chatId)
    if (
      chatTabs.length === 0 ||
      chatTabs.some((tab) => botChatTabHeld(tab, host.lastFocusedAt(workspaceId, tab), now))
    ) {
      continue
    }
    const sessions = new Set([
      chat.chatId,
      ...(chat.liveSessionId ? [chat.liveSessionId] : []),
      ...chatTabs.map((tab) => tab.sessionId)
    ])
    if (!host.settled([...sessions])) {
      continue
    }
    try {
      for (const tab of chatTabs) {
        await host.closeTab(workspaceId, tab.tabId)
      }
      closed.push(chat.chatId)
    } catch (error) {
      host.warn('[bots] could not close a settled chat tab', error)
    }
  }
  return closed
}

/** Runs a pass when one is due; never two at once. The first pass, a while after launch, also clears
 *  the tabs that piled up before this existed. */
export class BotChatTabTidyTicker {
  private firstTickAt: number | null = null
  private lastRunAt: number | null = null
  private running: Promise<string[]> | null = null

  constructor(private readonly host: () => BotChatTabTidyHost) {}

  tick(now: number): Promise<string[]> {
    this.firstTickAt ??= now
    const due =
      this.lastRunAt === null
        ? now - this.firstTickAt >= BOT_CHAT_TAB_TIDY_FIRST_AFTER_MS
        : now - this.lastRunAt >= BOT_CHAT_TAB_TIDY_EVERY_MS
    if (this.running || !due) {
      return Promise.resolve([])
    }
    this.lastRunAt = now
    const run = tidyBotChatTabs(this.host()).finally(() => {
      this.running = null
    })
    this.running = run
    return run
  }
}
