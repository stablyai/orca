// A bot's chats in the host list, from the model the desktop sidebar draws: each chat with an open
// tab, then (while it is open) its workers' lines and their paging.
import { botChatFoldKey, type BotChatFold } from '../../../src/shared/bots/bot-chat-tree'
import { buildBotSidebarTree } from '../../../src/shared/bots/bot-sidebar-tree'
import type { WorkspaceListItem } from '../worktree/workspace-list/workspace-list-types'
import type { MobileBotChatLineFacts } from './host-bot-row-facts'
import type { HostBotWorkerBranch } from './host-bot-worker-lines'
import type { HostBotChatTree } from './bot-chat-tree-reads'

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
  const view = buildBotSidebarTree({
    chats: tree.chats,
    workspaces: args.branches,
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
  const items: WorkspaceListItem[] = []
  for (const chatView of view.chats) {
    const { chat } = chatView
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
      items.push({
        row: home.row,
        view: {
          sectionListKey: `bot-chat-paging:${args.homeIdentity}:${chat.chatId}`,
          botChatPaging: {
            stepsKey: keyOf(chat.chatId),
            steps: chatView.steps,
            paging: chatView.paging
          },
          ...dim
        }
      })
    }
  }
  for (const branch of view.stray) {
    items.push(...lineItems(branch, view.notes.get(branch.id)))
  }
  return items
}
