// The tabs of a bot's request chats close by themselves once nothing needs them, the way a person's "x"
// closes a bot chat's tab: the chat keeps its transcript, draft and address, keeps running if anything
// comes, stays in the bot's Chats and Session History, and opens again from there. A request sent with
// `--chat new` opens a tab no one ever closed, so every finished or failed request stayed in the
// bot's sidebar for good. Only chats Orca started for a request are touched; a person's own are theirs.
import type { Bot } from '../../shared/bot-types'
import type { BotChatTreeChat } from '../../shared/bots/bot-chat-tree'
import { isBotGroupMemberSession } from '../../shared/bots/bot-group'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'

/** How long a chat sits untouched (no turn, no mail, its tab not focused) before its tab closes. */
export const BOT_CHAT_TAB_IDLE_MS = 24 * 60 * 60 * 1000
/** Between passes. */
export const BOT_CHAT_TAB_TIDY_EVERY_MS = 60 * 60 * 1000
/** From the first tick to the first pass, so launch's own work goes first; also the wait before the
 *  next pass while a backlog remains. */
export const BOT_CHAT_TAB_TIDY_SOON_MS = 10 * 60 * 1000
/** Close attempts one pass makes at most (closed, refused or failed alike), oldest chats first. */
export const BOT_CHAT_TAB_TIDY_MAX_CLOSES = 40
/** Chats one pass looks at closely at most, so a long list of kept chats costs a bounded pass too. */
export const BOT_CHAT_TAB_TIDY_MAX_LOOKS = 200

/** A chat tab in the bot's home, as one snapshot of the host's tabs lists it. */
export type BotChatTabTidyTab = {
  sessionId: string
  tabId: string
  /** In front of its tab group: what a person sees when they open the bot's home. */
  isActive: boolean
  isPinned?: true
  /** The snapshot it was read from; a close is refused once the tabs changed since. */
  publicationEpoch?: string
  snapshotVersion?: number
}

/** What holds a chat's tab, read from its records; `requestChat` false keeps it too. */
export type BotChatTabAdmission = {
  requestChat: boolean
  holds: readonly string[]
  /** Newest mail to or from it, when any. */
  lastMailAt: number | null
}

export type BotChatTabCloseOutcome = 'closed' | 'delegated' | 'refused'

export type BotChatTabTidyHost = {
  bots: () => readonly Pick<Bot, 'id' | 'folderWorkspaceId'>[]
  /** The bot's chats as its sidebar reads them, and the chat each session belongs to. */
  chats: (
    botId: string
  ) => Promise<{ chats: readonly BotChatTreeChat[]; rootOf: (sessionId: string) => string }>
  tabs: (workspaceId: string) => Promise<readonly BotChatTabTidyTab[]>
  /** The chat's provenance, its open work, waits, mail and items. */
  admission: (
    botId: string,
    chatId: string,
    lineage: readonly string[]
  ) => Promise<BotChatTabAdmission>
  /** Sessions with a restart recovery offer or failure still shown; hiding a tab would dismiss it. */
  restartHeld: () => Promise<ReadonlySet<string>>
  /** Read last: nothing attached, starting or on its way, nothing working or waiting on the owner,
   *  and no screen showing any of these sessions. */
  settled: (sessionIds: readonly string[]) => boolean
  /** When a person last focused the tab, from the saved layout; null when it never was or isn't known. */
  lastFocusedAt: (workspaceId: string, tab: BotChatTabTidyTab) => number | null
  /** Closes the tab as a person's "x" does, refused if the tabs changed since `tab`'s snapshot. */
  closeTab: (workspaceId: string, tab: BotChatTabTidyTab) => Promise<BotChatTabCloseOutcome>
  /** The bots whose chat tabs this pass closed, so their lists read again. */
  changed: (botIds: readonly string[]) => void
  /** Lets other work run between closes. */
  pause: () => Promise<void>
  now: () => number
  warn: (message: string, error: unknown) => void
}

export type BotChatTabTidyPass = {
  closed: string[]
  /** Refused or failed this pass: skipped once by the next, then tried again. */
  refused: string[]
  /** A budget ran out with chats still to look at. */
  more: boolean
}

/** Side chats (never Home, a thread, a group room or an automation run) open in a tab, not ended,
 *  idle with no worker running or waiting, with no turn for a day; oldest first. */
export function botChatTabsDue(
  chats: readonly BotChatTreeChat[],
  now: number,
  idleMs: number = BOT_CHAT_TAB_IDLE_MS
): BotChatTreeChat[] {
  return chats
    .filter(
      (chat) =>
        chat.origin === 'side' &&
        !chat.run &&
        !isBotGroupMemberSession(chat.chatId) &&
        !chat.closed &&
        chat.tab === true &&
        chat.live === 'idle' &&
        chat.runningTotal === 0 &&
        now - chat.lastActiveAt >= idleMs
    )
    .toSorted((a, b) => a.lastActiveAt - b.lastActiveAt)
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

type Budget = { closes: number; looks: number }

/** One pass over every bot on this host. A bot or chat that fails to read or close is skipped,
 *  never the whole pass. `skip`: chats refused last pass, passed over once. */
export async function tidyBotChatTabs(
  host: BotChatTabTidyHost,
  skip: ReadonlySet<string> = new Set(),
  budget: Budget = { closes: BOT_CHAT_TAB_TIDY_MAX_CLOSES, looks: BOT_CHAT_TAB_TIDY_MAX_LOOKS }
): Promise<BotChatTabTidyPass> {
  const pass: BotChatTabTidyPass = { closed: [], refused: [], more: false }
  let restartHeld: ReadonlySet<string> | null = null
  const held = async () => (restartHeld ??= await host.restartHeld())
  const changed: string[] = []
  for (const bot of host.bots()) {
    if (budget.closes <= 0 || budget.looks <= 0) {
      pass.more = true
      break
    }
    const before = pass.closed.length
    try {
      await tidyOneBot(host, bot, { skip, held, budget, pass })
    } catch (error) {
      host.warn('[bots] could not tidy chat tabs', error)
    }
    if (pass.closed.length > before) {
      changed.push(bot.id)
    }
  }
  if (changed.length > 0) {
    host.changed(changed)
  }
  return pass
}

type BotPass = {
  skip: ReadonlySet<string>
  held: () => Promise<ReadonlySet<string>>
  budget: Budget
  pass: BotChatTabTidyPass
}

async function tidyOneBot(
  host: BotChatTabTidyHost,
  bot: Pick<Bot, 'id' | 'folderWorkspaceId'>,
  { skip, held, budget, pass }: BotPass
): Promise<void> {
  const { chats, rootOf } = await host.chats(bot.id)
  const due = botChatTabsDue(chats, host.now()).filter((chat) => !skip.has(chat.chatId))
  if (due.length === 0) {
    return
  }
  const workspaceId = folderWorkspaceKey(bot.folderWorkspaceId)
  const tabsOf = (tabs: readonly BotChatTabTidyTab[], chatId: string) =>
    tabs.filter((tab) => rootOf(tab.sessionId) === chatId)
  const listed = await host.tabs(workspaceId)
  for (const chat of due) {
    if (budget.closes <= 0 || budget.looks <= 0) {
      pass.more = true
      return
    }
    budget.looks -= 1
    const lineage = (tabs: readonly BotChatTabTidyTab[]) => [
      ...new Set([
        chat.chatId,
        ...(chat.liveSessionId ? [chat.liveSessionId] : []),
        ...tabs.map((tab) => tab.sessionId)
      ])
    ]
    const kept = (tabs: readonly BotChatTabTidyTab[]) =>
      tabs.length === 0 ||
      tabs.some((tab) => botChatTabHeld(tab, host.lastFocusedAt(workspaceId, tab), host.now()))
    if (kept(tabsOf(listed, chat.chatId))) {
      continue
    }
    const admission = await host.admission(
      bot.id,
      chat.chatId,
      lineage(tabsOf(listed, chat.chatId))
    )
    const activeAt = Math.max(chat.lastActiveAt, admission.lastMailAt ?? Number.NEGATIVE_INFINITY)
    if (
      !admission.requestChat ||
      admission.holds.length > 0 ||
      host.now() - activeAt < BOT_CHAT_TAB_IDLE_MS
    ) {
      continue
    }
    // The tabs as they are now: a tab opened, brought forward or reopened since holds the chat.
    const tabs = tabsOf(await host.tabs(workspaceId), chat.chatId)
    const sessions = lineage(tabs)
    const recovery = await held()
    if (kept(tabs) || sessions.some((id) => recovery.has(id)) || !host.settled(sessions)) {
      continue
    }
    budget.closes -= 1
    await closeChatTabs(host, workspaceId, chat.chatId, tabs, pass)
    await host.pause()
  }
}

async function closeChatTabs(
  host: BotChatTabTidyHost,
  workspaceId: string,
  chatId: string,
  tabs: readonly BotChatTabTidyTab[],
  pass: BotChatTabTidyPass
): Promise<void> {
  try {
    for (const tab of tabs) {
      if ((await host.closeTab(workspaceId, tab)) === 'refused') {
        pass.refused.push(chatId)
        return
      }
    }
    pass.closed.push(chatId)
  } catch (error) {
    pass.refused.push(chatId)
    host.warn('[bots] could not close a settled chat tab', error)
  }
}

/** Runs a pass when one is due; never two at once. The first pass, a while after launch, also starts
 *  on the tabs that piled up before this existed; while some remain, the next pass comes sooner. */
export class BotChatTabTidyTicker {
  private firstTickAt: number | null = null
  private nextAt: number | null = null
  private running: Promise<BotChatTabTidyPass> | null = null
  private skip: ReadonlySet<string> = new Set()

  constructor(private readonly host: () => BotChatTabTidyHost) {}

  tick(now: number): Promise<BotChatTabTidyPass> {
    this.firstTickAt ??= now
    const nextAt = this.nextAt ?? this.firstTickAt + BOT_CHAT_TAB_TIDY_SOON_MS
    if (this.running || now < nextAt) {
      return Promise.resolve({ closed: [], refused: [], more: false })
    }
    this.nextAt = now + BOT_CHAT_TAB_TIDY_EVERY_MS
    const run = tidyBotChatTabs(this.host(), this.skip)
      .then((pass) => {
        this.skip = new Set(pass.refused)
        if (pass.more) {
          this.nextAt = now + BOT_CHAT_TAB_TIDY_SOON_MS
        }
        return pass
      })
      .finally(() => {
        this.running = null
      })
    this.running = run
    return run
  }
}
