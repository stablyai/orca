import type { ChatTurnsDeps } from './external-conversation-chat-turns-deps'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import { conversationPane } from './external-conversation-types'

export function emitChatTurnStart(
  deps: ChatTurnsDeps,
  linked: { link: ExternalConversationLink; workspace: { worktreeId: string } },
  at: number,
  onlySwitchNotice = false
): void {
  const switchedAgent = deps.switchedAgentForLink?.(linked.link)
  if (onlySwitchNotice && !switchedAgent) {
    return
  }
  const deliveryId = onlySwitchNotice ? undefined : deps.chatTurnDelivery(linked.link.sessionId, at)
  deps.emit({
    kind: 'turn-started',
    ...conversationPane(linked.link, linked.workspace.worktreeId),
    at,
    ...(deliveryId ? { deliveryId } : {}),
    ...(switchedAgent ? { switchedAgent } : {})
  })
}
