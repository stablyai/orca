// One bot's kept base in the chat-tree index, and how it changes in place: a record rewritten, a stamp
// check, the sessions and panes whose changes are this bot's.
import type { AgentSessionConversationView } from '../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import type { Bot } from '../../shared/bot-types'
import type { AgentSessionRecordReader } from '../runtime/orchestration/addressing/session-lineage/structured-session-lineage'
import { sessionTabClosedCheck } from '../runtime/orchestration/mailbox/routing/structured-session-mail-address'
import type { BotHomeRecords } from './bot-home-records'
import {
  botChatBaseChat,
  type BotChatBaseBuild,
  type BotChatBaseContext
} from './bot-chat-tree-base'

/** What of a record its chat row shows; a commit that leaves this as it was (a lease renewal, say)
 *  changes no chat. */
export function botChatRecordShown(record: AgentSessionConversationView): string {
  return JSON.stringify([
    record.location.workspaceId,
    record.conversationName ?? null,
    record.conversationNameSource ?? null,
    record.conversationCommand ?? null,
    record.lastTurn ?? null,
    record.provider,
    record.providerHandleChain.length > 0,
    // An unturned chat lists by when its record last changed.
    record.lastTurn ? null : record.updatedAt
  ])
}

export type BotChatTreeEntry = {
  build: BotChatBaseBuild
  /** Each home record's frozen row at build, so a read can tell a commit it never heard of. */
  stamps: Map<string, object | undefined>
  /** What each home record's chat row shows, so a commit that changes none of it is no change. */
  shown: Map<string, string>
  /** Each home record's tab closed or not, so a tab commit tells only the bots whose chats it moved. */
  tabClosed: Map<string, boolean>
  /** The chat each home record lists as, if any. */
  chatOfRecord: Map<string, string>
  /** Records changed in place since the build. */
  dirtySessions: Set<string>
  /** Chats joined, left, moved or were cleared: rebuild. */
  full: boolean
  creatorSessions: Set<string>
  creatorPanes: Set<string>
  worktrees: Set<string>
}

export function newBotChatTreeEntry(
  build: BotChatBaseBuild,
  records: readonly AgentSessionConversationView[],
  reader: AgentSessionRecordReader | null,
  home: Pick<BotHomeRecords, 'stampOf'>
): BotChatTreeEntry {
  const entry: BotChatTreeEntry = {
    build,
    stamps: new Map(
      records.map((record) => [
        record.sessionId,
        reader ? home.stampOf(reader, record.sessionId) : undefined
      ])
    ),
    shown: new Map(records.map((record) => [record.sessionId, botChatRecordShown(record)])),
    tabClosed: new Map(),
    chatOfRecord: new Map(
      [...build.sessionOfChat].map(([chatId, sessionId]) => [sessionId, chatId])
    ),
    dirtySessions: new Set(),
    full: false,
    creatorSessions: new Set(),
    creatorPanes: new Set(),
    worktrees: new Set()
  }
  if (reader) {
    const closed = sessionTabClosedCheck(reader)
    records.forEach((record) => entry.tabClosed.set(record.sessionId, closed(record.sessionId)))
  }
  indexBotChatTreeCreators(entry)
  return entry
}

/** A tab commit: the kept bots whose home records' tabs closed or reopened, those records marked to
 *  read again. Every kept bot from no reader. */
export function botChatTreeTabsMoved(
  entries: ReadonlyMap<string, BotChatTreeEntry>,
  reader: AgentSessionRecordReader | null
): string[] {
  if (!reader) {
    return [...entries.keys()]
  }
  const closed = sessionTabClosedCheck(reader)
  return [...entries].flatMap(([botId, entry]) => {
    let moved = false
    for (const sessionId of entry.stamps.keys()) {
      const now = closed(sessionId)
      if (entry.tabClosed.get(sessionId) !== now) {
        entry.tabClosed.set(sessionId, now)
        entry.dirtySessions.add(sessionId)
        moved = true
      }
    }
    return moved ? [botId] : []
  })
}

/** The sessions, panes and worktrees whose changes are this bot's, from its Dispatches as placed now. */
export function indexBotChatTreeCreators(entry: BotChatTreeEntry): void {
  const keys = entry.build.placement.creatorKeys()
  entry.creatorSessions = new Set(keys.sessions)
  entry.creatorPanes = new Set(keys.panes)
  entry.worktrees = new Set(entry.build.placement.worktreeIds())
}

/** Records changed in place: each one's chat again. False when one joined, left or moved lineage. */
export function refreshBotChatTreeSessions(
  ctx: BotChatBaseContext,
  bot: Bot,
  entry: BotChatTreeEntry,
  reader: AgentSessionRecordReader,
  home: Pick<BotHomeRecords, 'stampOf'>
): boolean {
  let closed: ((sessionId: string) => boolean) | undefined
  for (const sessionId of entry.dirtySessions) {
    const record = reader.getRecord(sessionId)
    if (!record) {
      return false
    }
    const before = entry.chatOfRecord.get(sessionId) ?? null
    const chat = botChatBaseChat(ctx, reader, bot, record, entry.build)
    // Became a chat, stopped being one, or lists under another root: the chats themselves changed.
    if ((chat?.chatId ?? null) !== before) {
      return false
    }
    if (chat) {
      entry.build.chats.set(chat.chatId, chat)
    }
    entry.stamps.set(sessionId, home.stampOf(reader, sessionId))
    entry.shown.set(sessionId, botChatRecordShown(record))
    entry.tabClosed.set(sessionId, (closed ??= sessionTabClosedCheck(reader))(sessionId))
  }
  entry.dirtySessions.clear()
  return true
}

/** A commit rewrote a home record: true when its chat row shows something new, else the index only
 *  takes the new row as read. */
export function botChatTreeRecordShowsNew(
  entry: BotChatTreeEntry,
  sessionId: string,
  reader: AgentSessionRecordReader,
  home: Pick<BotHomeRecords, 'stampOf'>
): boolean {
  const record = reader.getRecord(sessionId)
  if (!record || entry.dirtySessions.has(sessionId) || !entry.shown.has(sessionId)) {
    return true
  }
  if (botChatRecordShown(record) !== entry.shown.get(sessionId)) {
    return true
  }
  entry.stamps.set(sessionId, home.stampOf(reader, sessionId))
  return false
}

/** O(the bot's chats): a home record whose row is no longer the one the index read, unheard. */
export function botChatTreeStampsMissed(
  entry: BotChatTreeEntry,
  reader: AgentSessionRecordReader,
  home: Pick<BotHomeRecords, 'stampOf' | 'stamps'>
): boolean {
  if (!home.stamps(reader)) {
    return false
  }
  for (const [sessionId, stamp] of entry.stamps) {
    if (!entry.dirtySessions.has(sessionId) && home.stampOf(reader, sessionId) !== stamp) {
      return true
    }
  }
  return false
}
