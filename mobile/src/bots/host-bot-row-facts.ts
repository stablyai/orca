import { parseBotAvatar, type BotMascotId } from '../../../src/shared/bot-avatar'
import type { Bot } from '../../../src/shared/bot-types'
import { wornBotOutfit, type BotAvatarOutfit } from '../../../src/shared/bots/bot-avatar-outfit'
import { botFallback } from '../../../src/shared/bots/bot-avatar-fallback'
import type { BotRowStatus } from '../../../src/shared/bots/bot-row-status'
import type { ExecutionHostId } from '../../../src/shared/execution-host/execution-host'
import type { BotGroup } from '../../../src/shared/bots/bot-group'
import type {
  BotChatTranslate as Translate,
  BotChatTreeChat
} from '../../../src/shared/bots/bot-chat-tree'
import type { BotRowLineInput } from '../../../src/shared/bots/bot-row-line'
import type { BotSidebarLineNote } from '../../../src/shared/bots/bot-sidebar-chat-groups'
import type {
  BotSidebarChatTrailing,
  BotSidebarWorkerPaging
} from '../../../src/shared/bots/bot-sidebar-tree'
import type { botGroupStatusOf } from '../../../src/shared/bots/bot-group-status'
import type { botFoldLiveStatus } from '../../../src/shared/bots/bot-sidebar-workspaces'

export type MobileBotAvatarSource =
  /** `color` is its tile's, drawn behind the transparent picture; absent, the mascots' own sky blue. */
  | { kind: 'mascot'; id: BotMascotId; color?: string; outfit?: BotAvatarOutfit }
  /** A picture in hand, such as one just picked. */
  | { kind: 'image'; uri: string }
  /** A bot's uploaded picture, drawn once read; until then, `text`. */
  | { kind: 'upload'; botId: string; avatar: string; text: string }
  | { kind: 'text'; text: string }

/** What a bot's row draws over its home folder's row. */
export type MobileBotRowFacts = {
  botId: string
  /** Its chats list under it, so it folds even with no workspace. */
  foldsChats?: true
  avatar: MobileBotAvatarSource
  /** Rolled up with its workspaces, for the bot's own screen. */
  status: BotRowStatus
  /** The row's dot: the bot's own turn only. */
  dot: BotRowStatus
  /** A folded row's glyph: its most urgent live workspace. */
  foldLive: ReturnType<typeof botFoldLiveStatus>
  /** New Up next suggestions, counted apart from unread. */
  upNext?: number
  /** What its line reads beside the home's agent rows: its Chat, its threads' links, its waits. */
  line: Omit<BotRowLineInput<never>, 'paused' | 'rows' | 'now' | 'startingSessionIds'>
  /** The first person asking for access, whom the Needs you line names. */
  askedForAccess?: string
  statusLine: string
  /** What it's for, cut to show the match, when a search found it by that and not its name. */
  searchPurpose?: string
  paused: boolean
  /** A server's bot: its computer, and that computer's word while it is down. */
  host?: { id: ExecutionHostId; label: string; word?: string }
}

/** What a group's row draws over its hidden home's row. */
export type MobileBotGroupRowFacts = {
  group: BotGroup
  members: readonly { id: string; name: string; avatar: MobileBotAvatarSource }[]
  dot: ReturnType<typeof botGroupStatusOf>
}

/** What a bot's chat row draws: the shared tree's chat, and where its fold is kept. */
export type MobileBotChatRowFacts = {
  /** `hostBotsKey` of the bot's host, which the phone's chat folds are kept under. */
  hostKey: string
  botId: string
  chat: BotChatTreeChat
  foldable: boolean
  open: boolean
  trailing: BotSidebarChatTrailing | null
}

/** A chat's worker paging: "Show 8 more workers", a last step's count, and "Show fewer" after a step. */
export type MobileBotChatPagingFacts = {
  /** `botChatFoldKey` of the chat, which its steps are kept under. */
  stepsKey: string
  steps: number
  paging: BotSidebarWorkerPaging | null
}

/** A worker's workspace under its chat: how deep it sits, and its note. */
export type MobileBotChatLineFacts = {
  /** 1 under its chat; each child workspace one more. */
  depth: number
  note?: BotSidebarLineNote
}

/** The bot's mascot, its upload, or its emoji or initial, as the desktop draws it. */
export function mobileBotAvatarSource(
  /** No id: a draft, whose upload no host can answer yet. */
  bot: Pick<Bot, 'name' | 'avatar' | 'avatarColor' | 'avatarOutfit'> & { id?: string }
): MobileBotAvatarSource {
  const parsed = parseBotAvatar(bot.avatar)
  const outfit = wornBotOutfit(bot.avatarOutfit)
  if (parsed?.kind === 'mascot') {
    return {
      kind: 'mascot',
      id: parsed.id,
      ...(bot.avatarColor ? { color: bot.avatarColor } : {}),
      ...(outfit ? { outfit } : {})
    }
  }
  if (parsed?.kind === 'upload' && bot.avatar && bot.id) {
    return { kind: 'upload', botId: bot.id, avatar: bot.avatar, text: botFallback(bot) }
  }
  return { kind: 'text', text: botFallback(bot) }
}

// The desktop's words for a bot's state (its row's details card).
export function botStatusLine(status: BotRowStatus, paused: boolean, t: Translate): string {
  if (paused) {
    return t('bots.row.paused', 'Paused')
  }
  switch (status) {
    case 'working':
      return t('sidebar.cardSlot.working', 'Working')
    case 'permission':
      return t('workspace.activity.permission', 'Needs permission')
    case 'active':
    case 'inactive':
      return t('bots.row.idle', 'Idle')
  }
}
