// Opening one of the bot's chats from this screen: Home Chat switches to its live tab (a /clear moved
// it past the chat id others name), and any other chat opens as its tab, as the desktop's does.
import type { StructuredSessionOpenSource } from '../../../src/shared/agent-session/view/open-structured-agent-session'
import type { MobileSessionController } from './use-mobile-session-controller'

export type BotChatTabScope = Pick<
  MobileSessionController,
  'sessionTabs' | 'activeSessionTabId' | 'switchSessionTab' | 'worktreeId'
> & {
  homeChatId: string | null | undefined
  openNativeSession: (source: StructuredSessionOpenSource) => Promise<unknown>
}

export function openBotChatTab(
  chat: { chatId: string | null; home: boolean },
  scope: BotChatTabScope
): void {
  const { homeChatId, sessionTabs } = scope
  const homeTab = homeChatId
    ? sessionTabs.find((tab) => tab.type === 'agent-session' && tab.sessionId === homeChatId)
    : undefined
  if (chat.home && homeTab) {
    if (scope.activeSessionTabId !== homeTab.id) {
      scope.switchSessionTab(homeTab)
    }
    return
  }
  if (chat.chatId) {
    void scope.openNativeSession({
      kind: 'history',
      structuredSession: { sessionId: chat.chatId, workspaceId: scope.worktreeId }
    })
  }
}
