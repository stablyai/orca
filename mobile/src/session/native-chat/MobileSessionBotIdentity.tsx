import { useCallback, useMemo, useState, type ReactNode } from 'react'
import type { RouteBot } from '../../bots/use-route-bot'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { ConnectionState } from '../../transport/connection/connection-state'
import {
  MobileNativeChatBotIdentityContext,
  MobileNativeChatBotWaitsContext
} from './mobile-native-chat-bot-identity'
import { waitHostRead } from '../../../../src/shared/automations/automation-chat-row'
import { useMobileBotChatIdentity } from './use-mobile-bot-chat-identity'
import {
  MobileSlackMirrorContext,
  useMobileSlackMirror
} from './slack-mirror/use-mobile-slack-mirror'
import { MobileSlackMirrorSheet } from './slack-mirror/MobileSlackMirrorSheet'

/** Gives the open chat its bot's identity: the route's bot, for the chat sessions it owns. */
export function MobileSessionBotIdentity({
  controller,
  children
}: {
  controller: {
    routeBot: RouteBot | null
    client: RpcClient | null
    connState: ConnectionState
    activeSessionTab?: { type: string; sessionId?: string | null } | null
  }
  children: ReactNode
}): React.JSX.Element {
  const tab = controller.activeSessionTab
  const chatSessionId = tab?.type === 'agent-session' ? (tab.sessionId ?? null) : null
  const turnBot = useMobileBotChatIdentity(
    controller.routeBot,
    controller.client,
    controller.connState,
    chatSessionId
  )
  const activity = controller.routeBot?.activity ?? null
  const turnBotId = turnBot?.botId ?? null
  const waits = useMemo(
    () => (turnBotId ? waitHostRead(turnBotId, activity) : null),
    [turnBotId, activity]
  )
  const [sheetOpen, setSheetOpen] = useState(false)
  const openSheet = useCallback(() => setSheetOpen(true), [])
  // Only a chat this bot owns can be its Slack thread's.
  const slackMirror = useMobileSlackMirror(
    turnBot ? (controller.routeBot?.bot ?? null) : null,
    controller.client,
    controller.connState,
    chatSessionId,
    openSheet
  )
  return (
    <MobileNativeChatBotIdentityContext.Provider value={turnBot}>
      <MobileNativeChatBotWaitsContext.Provider value={waits}>
        <MobileSlackMirrorContext.Provider value={slackMirror}>
          {children}
          <MobileSlackMirrorSheet
            mirror={slackMirror}
            open={sheetOpen && slackMirror !== null}
            onClose={() => setSheetOpen(false)}
          />
        </MobileSlackMirrorContext.Provider>
      </MobileNativeChatBotWaitsContext.Provider>
    </MobileNativeChatBotIdentityContext.Provider>
  )
}
