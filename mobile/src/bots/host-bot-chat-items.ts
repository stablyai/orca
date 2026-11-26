// A bot's chats in the host list, from the model the desktop sidebar draws: each chat that replies,
// waits on the owner or is unread (never Home Chat, which the bot's row opens), then (while it is
// open) its workers' lines and their paging. Every other workspace of the bot lists flat above them,
// paged as a chat's, since the project list leaves all of them out.
import {
  botChatFoldKey,
  chatIsGoing,
  type BotChatFold,
  type BotChatTreeChat
} from '../../../src/shared/bots/bot-chat-tree'
import {
  botLiveWorkspaceRanks,
  botSidebarListedChats,
  pageChatLines,
  sortBotWorkspacesByLiveRank
} from '../../../src/shared/bots/bot-sidebar-chat-groups'
import {
  botSidebarWorkerPaging,
  buildBotSidebarTree,
  type BotSidebarWorkerPaging
} from '../../../src/shared/bots/bot-sidebar-tree'
import type { WorkspaceListItem } from '../worktree/workspace-list/workspace-list-types'
import type { MobileBotChatLineFacts } from './host-bot-row-facts'
import type { HostBotWorkerBranch } from './host-bot-worker-lines'
import type { HostBotChatTree } from './bot-chat-tree-reads'

/** Not a chat id (chat ids are session ids): the steps key of the bot's flat lines. */
const FLAT_LINES_KEY = '\u0000flat-lines'

/** A chat the list shows under its bot: one that needs a look now. */
function listsUnderBot(chat: BotChatTreeChat): boolean {
  return chat.origin !== 'home' && (chatIsGoing(chat) || chat.unread || chat.unseen === true)
}

/** The bot's chat rows and their lines; null while it has no chats read (an older host, or not yet),
 *  so the bot keeps its flat workspace lines. */
export function hostBotChatItems(args: {
  tree: HostBotChatTree | undefined
  /** The bot's shown workers in the list's order, placed (host pills, dimming). */
  branches: readonly HostBotWorkerBranch[]
  /** The bot's home row, which its chat and paging rows are drawn over. */
  home: WorkspaceListItem
  homeIdentity: string
  hostKey: string
  botId: string
  folds: Readonly<Record<string, BotChatFold>>
  steps: Readonly<Record<string, number>>
  dimmed: boolean
}): WorkspaceListItem[] | null {
  const { tree, home, hostKey, botId } = args
  if (!tree || tree.chats.length === 0) {
    return null
  }
  const dim = args.dimmed ? { dimmed: true as const } : {}
  const keyOf = (chatId: string) => botChatFoldKey(hostKey, botId, chatId)
  // Each workspace lists once: under a chat the list shows, else flat under the bot.
  const shownChats = new Set(
    botSidebarListedChats(tree.chats)
      .filter(listsUnderBot)
      .map(({ chatId }) => chatId)
  )
  const underChat = (branch: HostBotWorkerBranch) =>
    shownChats.has(tree.workspaceChats[branch.id] ?? '')
  const rest = args.branches.filter((branch) => !underChat(branch))
  const view = buildBotSidebarTree({
    chats: tree.chats,
    workspaces: args.branches.filter(underChat),
    workspaceChats: tree.workspaceChats,
    foldOf: (chatId) => args.folds[keyOf(chatId)],
    stepsOf: (chatId) => args.steps[keyOf(chatId)] ?? 0,
    activeLineId: args.branches.find((branch) => branch.lines[0]?.row.isActive)?.id ?? null
  })
  const lineItems = (
    branch: HostBotWorkerBranch,
    note: MobileBotChatLineFacts['note'] | undefined
  ): WorkspaceListItem[] =>
    branch.lines.map((line, index) => ({
      row: line.row,
      view: {
        ...line.view,
        botChatLine: {
          depth: line.view.projectGroupDepth ?? 1,
          // The note is the worker's own; its children carry none.
          ...(index === 0 && note ? { note } : {})
        }
      }
    }))
  const pagingItem = (
    id: string,
    steps: number,
    paging: BotSidebarWorkerPaging | null
  ): WorkspaceListItem => ({
    row: home.row,
    view: {
      sectionListKey: `bot-chat-paging:${args.homeIdentity}:${id}`,
      botChatPaging: { stepsKey: keyOf(id), steps, paging },
      ...dim
    }
  })
  const items: WorkspaceListItem[] = []
  for (const chatView of view.chats) {
    const { chat } = chatView
    if (!shownChats.has(chat.chatId)) {
      continue
    }
    items.push({
      row: home.row,
      view: {
        sectionListKey: `bot-chat:${args.homeIdentity}:${chat.chatId}`,
        botChat: {
          hostKey,
          botId,
          chat,
          foldable: chatView.foldable,
          open: chatView.open,
          trailing: chatView.trailing
        },
        ...dim
      }
    })
    if (!chatView.open) {
      continue
    }
    for (const branch of chatView.lines) {
      items.push(...lineItems(branch, view.notes.get(branch.id)))
    }
    if (chatView.paging || chatView.steps > 0) {
      items.push(pagingItem(chatView.chat.chatId, chatView.steps, chatView.paging))
    }
  }
  // Every workspace no shown chat has (Home Chat's, a quiet or closed chat's) leads, flat, so none
  // reads as a listed chat's: live ones and the open one always, the rest paged as a chat's lines.
  if (rest.length === 0) {
    return items
  }
  const flatSteps = args.steps[keyOf(FLAT_LINES_KEY)] ?? 0
  const ranks = botLiveWorkspaceRanks(tree.chats)
  const live: HostBotWorkerBranch[] = []
  const idle: HostBotWorkerBranch[] = []
  for (const branch of rest) {
    if (branch.lines.some((line) => ranks.has(line.row.worktreeId))) {
      live.push(branch)
    } else {
      idle.push(branch)
    }
  }
  // Idle ones keep the list's order; only live ones rank, those waiting on the owner first.
  const flat = live.length > 0 ? [...sortBotWorkspacesByLiveRank(live, ranks), ...idle] : idle
  const page = pageChatLines(flat, new Set(live.map(({ id }) => id)), flatSteps)
  const leading = flat
    .filter((branch, index) => index < page.shown || branch.lines.some((line) => line.row.isActive))
    .flatMap((branch) => lineItems(branch, view.notes.get(branch.id)))
  if (page.remaining > 0 || flatSteps > 0) {
    leading.push(pagingItem(FLAT_LINES_KEY, flatSteps, botSidebarWorkerPaging(page.remaining)))
  }
  return [...leading, ...items]
}
