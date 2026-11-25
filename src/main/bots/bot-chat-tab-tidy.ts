// The tabs of the chats Orca started for bot requests close by themselves once nothing needs them: the
// chat keeps its transcript, draft, address and restart recovery, keeps running if anything comes,
// stays in the bot's Chats and Session History, and opens again from there. A request sent with
// `--chat new` opens a tab no one ever closed, so every finished or failed request stayed in the bot's
// sidebar for good. A person's own chats are never touched.
import type { Bot } from '../../shared/bot-types'
import type { BotChatTreeChat } from '../../shared/bots/bot-chat-tree'
import { isBotGroupMemberSession } from '../../shared/bots/bot-group'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'

/** How long a chat sits untouched (no turn, no mail, its tab not focused or reopened) before its tab closes. */
export const BOT_CHAT_TAB_IDLE_MS = 24 * 60 * 60 * 1000
/** Between passes. */
export const BOT_CHAT_TAB_TIDY_EVERY_MS = 60 * 60 * 1000
/** From the first tick to the first pass; also the wait before the next pass while a budget ran out. */
export const BOT_CHAT_TAB_TIDY_SOON_MS = 10 * 60 * 1000
/** Close attempts one pass makes at most (each asks the window and writes the hide). */
export const BOT_CHAT_TAB_TIDY_MAX_CLOSES = 40
/** Candidates one pass reads the records of at most. */
export const BOT_CHAT_TAB_TIDY_MAX_LOOKS = 200

/** A chat tab in the bot's home, as one snapshot of the host's tabs lists it. */
export type BotChatTabTidyTab = {
  sessionId: string
  tabId: string
  /** In front of its tab group. */
  isActive: boolean
  isPinned?: true
}

/** The host's verdict on one candidate from its records: keep, or go with the check the hide's write
 *  runs again (it throws when anything changed). */
export type BotChatTabAdmission = { kind: 'keep'; why: string } | { kind: 'go'; admit: () => void }

export type BotChatTabConsent = 'consent' | 'kept' | 'error'
export type BotChatTabHide = 'committed' | 'refused' | 'error'

export type BotChatTabTidyHost = {
  bots: () => readonly Pick<Bot, 'id' | 'folderWorkspaceId'>[]
  /** The bot's chats as its sidebar reads them, and the chat (/clear root) each session belongs to. */
  chats: (
    botId: string
  ) => Promise<{ chats: readonly BotChatTreeChat[]; rootOf: (sessionId: string) => string }>
  tabs: (workspaceId: string) => Promise<readonly BotChatTabTidyTab[]>
  /** When a person last focused the tab, from the saved layout; null when never or unknown. */
  lastFocusedAt: (workspaceId: string, tab: BotChatTabTidyTab) => number | null
  /** Provenance, lineage, holds, items, activity, recovery and rest, read now. */
  admission: (
    botId: string,
    chat: BotChatTreeChat,
    tab: BotChatTabTidyTab
  ) => Promise<BotChatTabAdmission>
  /** The window that owns the layout says whether the tab may go; it closes nothing. */
  consent: (workspaceId: string, tab: BotChatTabTidyTab) => Promise<BotChatTabConsent>
  /** The background hide, keeping restart recovery, committed only if `admit` passes in its write. */
  hide: (tab: BotChatTabTidyTab, admit: () => void) => Promise<BotChatTabHide>
  /** The bots whose chat tabs this pass hid, so their lists read again. */
  changed: (botIds: readonly string[]) => void
  /** Lets other work run between closes. */
  pause: () => Promise<void>
  now: () => number
  warn: (message: string, error: unknown) => void
}

export type BotChatTabTidyPass = {
  closed: string[]
  /** The window kept it, the write refused it, or a step failed: tried again on a later lap. */
  refused: string[]
  /** A budget ran out before every candidate was looked at. */
  more: boolean
}

/** Where a pass stopped, so the next one resumes after it: across bots, then oldest first. */
export type BotChatTabCursor = { botId: string; at: number; chatId: string }

/** Side chats open in a tab (never Home, a thread, a group room or an automation run), not ended, idle
 *  with no worker running or waiting, with no turn for a day. */
export function botChatTabsDue(
  chats: readonly BotChatTreeChat[],
  now: number,
  idleMs: number = BOT_CHAT_TAB_IDLE_MS
): BotChatTreeChat[] {
  return chats.filter(
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

type Candidate = {
  bot: Pick<Bot, 'id' | 'folderWorkspaceId'>
  chat: BotChatTreeChat
  rootOf: (sessionId: string) => string
  key: BotChatTabCursor
}

function compareKeys(a: BotChatTabCursor, b: BotChatTabCursor): number {
  if (a.botId !== b.botId) {
    return a.botId < b.botId ? -1 : 1
  }
  if (a.at !== b.at) {
    return a.at - b.at
  }
  return a.chatId < b.chatId ? -1 : a.chatId > b.chatId ? 1 : 0
}

/** Every bot's due chats in one stable order, starting just after `cursor` and wrapping. */
async function orderedCandidates(
  host: BotChatTabTidyHost,
  cursor: BotChatTabCursor | null
): Promise<Candidate[]> {
  const all: Candidate[] = []
  const now = host.now()
  for (const bot of host.bots()) {
    try {
      const { chats, rootOf } = await host.chats(bot.id)
      for (const chat of botChatTabsDue(chats, now)) {
        all.push({
          bot,
          chat,
          rootOf,
          key: { botId: bot.id, at: chat.lastActiveAt, chatId: chat.chatId }
        })
      }
    } catch (error) {
      host.warn('[bots] could not read chats to tidy', error)
    }
  }
  all.sort((a, b) => compareKeys(a.key, b.key))
  const start = cursor ? all.findIndex((entry) => compareKeys(entry.key, cursor) > 0) : 0
  return start <= 0 ? all : [...all.slice(start), ...all.slice(0, start)]
}

type PassState = {
  pass: BotChatTabTidyPass
  closes: number
  looks: number
  tabsByWorkspace: Map<string, Promise<readonly BotChatTabTidyTab[]>>
}

/** One pass over every bot on this host, resuming after `cursor`. Returns where it stopped. */
export async function tidyBotChatTabs(
  host: BotChatTabTidyHost,
  cursor: BotChatTabCursor | null = null,
  budget: { closes: number; looks: number } = {
    closes: BOT_CHAT_TAB_TIDY_MAX_CLOSES,
    looks: BOT_CHAT_TAB_TIDY_MAX_LOOKS
  }
): Promise<BotChatTabTidyPass & { cursor: BotChatTabCursor | null }> {
  const state: PassState = {
    pass: { closed: [], refused: [], more: false },
    closes: budget.closes,
    looks: budget.looks,
    tabsByWorkspace: new Map()
  }
  const changed = new Set<string>()
  let last = cursor
  for (const candidate of await orderedCandidates(host, cursor)) {
    if (state.closes <= 0 || state.looks <= 0) {
      state.pass.more = true
      break
    }
    last = candidate.key
    try {
      if (await tidyCandidate(host, candidate, state)) {
        changed.add(candidate.bot.id)
      }
    } catch (error) {
      host.warn('[bots] could not tidy a chat tab', error)
    }
  }
  if (changed.size > 0) {
    host.changed([...changed])
  }
  return { ...state.pass, cursor: state.pass.more ? last : null }
}

/** True when the hide committed. */
async function tidyCandidate(
  host: BotChatTabTidyHost,
  { bot, chat, rootOf }: Candidate,
  state: PassState
): Promise<boolean> {
  const workspaceId = folderWorkspaceKey(bot.folderWorkspaceId)
  const listTabs = (): Promise<readonly BotChatTabTidyTab[]> => {
    let tabs = state.tabsByWorkspace.get(workspaceId)
    if (!tabs) {
      tabs = host.tabs(workspaceId)
      state.tabsByWorkspace.set(workspaceId, tabs)
    }
    return tabs
  }
  const held = (tab: BotChatTabTidyTab) =>
    botChatTabHeld(tab, host.lastFocusedAt(workspaceId, tab), host.now())
  // Exactly one tab for the chat: more than one surface is a person's doing, and stays.
  const mine = (await listTabs()).filter((tab) => rootOf(tab.sessionId) === chat.chatId)
  if (mine.length !== 1 || held(mine[0])) {
    return false
  }
  state.looks -= 1
  const admission = await host.admission(bot.id, chat, mine[0])
  if (admission.kind === 'keep') {
    return false
  }
  // The tab as it is now: brought forward, pinned or replaced since keeps it.
  const fresh = (await host.tabs(workspaceId)).filter(
    (tab) => rootOf(tab.sessionId) === chat.chatId
  )
  if (fresh.length !== 1 || fresh[0].tabId !== mine[0].tabId || held(fresh[0])) {
    return false
  }
  state.closes -= 1
  const consent = await host.consent(workspaceId, fresh[0])
  const outcome = consent === 'consent' ? await host.hide(fresh[0], admission.admit) : consent
  await host.pause()
  if (outcome === 'committed') {
    state.pass.closed.push(chat.chatId)
    return true
  }
  state.pass.refused.push(chat.chatId)
  return false
}

/** Runs a pass when one is due; never two at once. The first pass comes a while after launch; while a
 *  budget runs out, the next comes sooner and resumes where it stopped. */
export class BotChatTabTidyTicker {
  private firstTickAt: number | null = null
  private nextAt: number | null = null
  private running: Promise<BotChatTabTidyPass> | null = null
  private cursor: BotChatTabCursor | null = null

  constructor(private readonly host: () => BotChatTabTidyHost) {}

  tick(now: number): Promise<BotChatTabTidyPass> {
    this.firstTickAt ??= now
    const nextAt = this.nextAt ?? this.firstTickAt + BOT_CHAT_TAB_TIDY_SOON_MS
    if (this.running || now < nextAt) {
      return Promise.resolve({ closed: [], refused: [], more: false })
    }
    this.nextAt = now + BOT_CHAT_TAB_TIDY_EVERY_MS
    const run = tidyBotChatTabs(this.host(), this.cursor)
      .then(({ cursor, ...pass }) => {
        this.cursor = cursor
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
