import { structuredSessionIdFromNotificationPane } from '../../../shared/agent-session/view/structured-session-notification-pane'
import { resolveNativeChatTranscriptAgent } from '../../../shared/native-chat/native-chat-agent-support'
import type { NotificationReplyTarget } from '../../../shared/notifications/notification-reply'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { MobileNotificationEvent } from './notifications/runtime-mobile-notification-controller'
import {
  botItemUidOfPaneKey,
  botGroupIdOfRoomPaneKey
} from '../../../shared/bots/bot-notification-pane-keys'

export function notificationReplyTarget(
  runtime: OrcaRuntimeService,
  event: MobileNotificationEvent
): NotificationReplyTarget | null {
  if (event.type !== 'notification' || !event.worktreeId || !event.paneKey) {
    return null
  }
  const sessionId = structuredSessionIdFromNotificationPane(event.paneKey)
  const itemUid = botItemUidOfPaneKey(event.paneKey)
  const groupId = botGroupIdOfRoomPaneKey(event.paneKey)
  if (groupId) {
    return { type: 'group', groupId }
  }
  if (itemUid) {
    return { type: 'bot-item', itemUid }
  }
  if (sessionId) {
    return { type: 'chat', sessionId }
  }
  const agent = runtime.agentTransitions.latestRow(event.paneKey)?.agentType
  if (!agent || !resolveNativeChatTranscriptAgent(agent)) {
    return null
  }
  try {
    const terminal = runtime.resolveTerminalPane(event.paneKey, event.worktreeId)
    return terminal.incarnationId
      ? {
          type: 'terminal',
          terminal: terminal.handle,
          expectedIncarnationId: terminal.incarnationId
        }
      : null
  } catch {
    return null
  }
}

export function captureNotificationReplyTarget(
  event: MobileNotificationEvent,
  resolve: ((event: MobileNotificationEvent) => NotificationReplyTarget | null) | undefined,
  expected?: NotificationReplyTarget | null
): NotificationReplyTarget | null {
  try {
    const target = resolve?.(event) ?? null
    return expected === undefined || JSON.stringify(target) === JSON.stringify(expected)
      ? target
      : null
  } catch {
    return null
  }
}
