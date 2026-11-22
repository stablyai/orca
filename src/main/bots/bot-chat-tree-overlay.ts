// A bot's chats as a read shows them: its base's chats with live status, tabs, read state and seen
// marks laid over them, read fresh on every read.
import type { AgentStatusIpcPayload } from '../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { AgentListVerdict } from '../../shared/agent-status/presentation/agent-list-status'
import type { BotChatFacts } from '../../shared/bots/bot-chat-tree-model'
import type { BotChatBaseChat, BotChatInputs } from './bot-chat-tree-base'
import { chatLive, chatReadUnread, terminalRunChats } from './bot-chat-tree-rows'

/** The base's chats as a read shows them: each with its live status, tab, read state and seen mark,
 *  then the automation runs that have no chat of their own. */
export function overlayBotChats(
  chats: readonly BotChatBaseChat[],
  inputs: BotChatInputs,
  live: {
    rowByPaneKey: ReadonlyMap<string, AgentStatusIpcPayload>
    readVerdicts: Readonly<Record<string, AgentListVerdict>> | undefined
    /** Each chat's tab title, by chat. */
    tabTitles: ReadonlyMap<string, string>
    tabbed: ReadonlySet<string>
    unseen: ReadonlySet<string>
    /** Each chat's countdown and when Orca closed it, from the host's auto-close. */
    autoClose?: (chatId: string) => Pick<BotChatFacts, 'autoClose' | 'autoClosedAt'>
  }
): BotChatFacts[] {
  const shown = chats.filter((chat) => !chat.empty || live.tabbed.has(chat.chatId))
  return [
    ...shown.map((chat): BotChatFacts => {
      const status = live.rowByPaneKey.get(chat.paneKey)
      return {
        chatId: chat.chatId,
        title: chat.home ? chat.title : live.tabTitles.get(chat.chatId) || chat.title,
        origin: chat.origin,
        ...(chat.originLabel ? { originLabel: chat.originLabel } : {}),
        live: chatLive(status),
        ...(chat.liveSessionId ? { liveSessionId: chat.liveSessionId } : {}),
        lastActiveAt: chat.lastActiveAt,
        // The desktop window's read verdict, so the phone shows what it shows; a desktop re-reads against its own acks.
        unread: chatReadUnread(live.readVerdicts?.[chat.paneKey]),
        ...(status?.state === 'done' && status.stateStartedAt
          ? { turnDone: { paneKey: chat.paneKey, at: status.stateStartedAt } }
          : {}),
        closed: chat.closed,
        ...(chat.closed ? { closedAt: chat.lastActiveAt } : {}),
        ...(chat.preview ? { preview: chat.preview } : {}),
        tab: live.tabbed.has(chat.chatId),
        ...(live.unseen.has(chat.chatId) ? { unseen: true } : {}),
        ...live.autoClose?.(chat.chatId)
      }
    }),
    ...terminalRunChats(inputs.runs, inputs.automationById, live.rowByPaneKey)
  ]
}
