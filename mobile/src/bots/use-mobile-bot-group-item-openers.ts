// Where a group's Items rows lead: a member's chat (this group's room in place, its Home, or that chat
// once its host has the tab ready, else Home, as a card's link does) and a worker where its host finds it.
import { useEffect, useMemo } from 'react'
import { structuredAgentSessionPaneKey } from '../../../src/shared/agent-session/view/structured-agent-session-projection'
import { findBotGroupRoomOfSession, type BotGroup } from '../../../src/shared/bots/bot-group'
import type { BotChatTreeWorker } from '../../../src/shared/bots/bot-chat-tree'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId
} from '../../../src/shared/execution-host/execution-host'
import { openMobileStructuredSession } from '../session/native-chat/agent-session/open-mobile-structured-session'
import { botCardChatOpener } from '../session/native-chat/transcript/bot-cards/mobile-bot-card-chat-open'
import { useOpenMobileSession } from '../session/use-open-mobile-session'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { botHomeWorktreeId } from './host-bots-read'
import type { PhoneBot } from './host-bots-operations'
import { openBotItemWorker } from './items/bot-item-worker-open'
import { useOpenBotHome } from './use-open-bot-home'

export function useMobileBotGroupItemOpeners({
  client,
  hostId,
  group,
  onClose,
  onOpenRoom,
  showToast
}: {
  client: RpcClient | null
  hostId: string
  group: BotGroup | null
  onClose: () => void
  onOpenRoom: (threadId: string | undefined) => void
  showToast: (message: string) => void
}) {
  const openMobileSession = useOpenMobileSession()
  const openBotHome = useOpenBotHome()
  const chatOpener = useMemo(
    () =>
      botCardChatOpener({
        ready: async (bot, chatId, current) =>
          client
            ? openMobileStructuredSession({
                client,
                current,
                source: {
                  kind: 'history',
                  structuredSession: { sessionId: chatId, workspaceId: botHomeWorktreeId(bot) }
                }
              })
            : { kind: 'superseded' },
        show: (bot, chatId, opened) =>
          openMobileSession({
            hostId,
            worktreeId: opened.worktreeId,
            paneKey: structuredAgentSessionPaneKey(opened.tabId, chatId),
            name: bot.name
          }),
        home: (bot, current) =>
          openBotHome({ pairedHostId: hostId, executionHost: LOCAL_EXECUTION_HOST_ID }, bot, {
            current
          })
      }),
    [client, hostId, openMobileSession, openBotHome]
  )
  useEffect(() => chatOpener.cancel, [chatOpener])
  return {
    chat: (bot: PhoneBot | undefined, chatId: string, home: boolean) => {
      // A newer choice wins over a side chat still waiting on its host.
      chatOpener.cancel()
      onClose()
      const room = group ? findBotGroupRoomOfSession([group], chatId) : null
      if (room) {
        onOpenRoom(room.threadId)
      } else if (bot && home) {
        chatOpener.home(bot)
      } else if (bot) {
        chatOpener.open(bot, chatId)
      }
    },
    /** `current`: false once the view that asked is gone, so a late lookup opens nothing. */
    worker: (worker: BotChatTreeWorker, current: () => boolean) => {
      chatOpener.cancel()
      openBotItemWorker(worker, {
        client,
        loaded: [],
        open: (target) => {
          if (target.worktreeId) {
            onClose()
            // A worker on another paired server opens there, as the bot panel's does.
            const workerHost = parseExecutionHostId(target.hostId)
            openMobileSession({
              hostId,
              worktreeId: target.worktreeId,
              ...(target.paneKey ? { paneKey: target.paneKey } : {}),
              ...(workerHost?.kind === 'runtime' ? { executionHost: workerHost.id } : {})
            })
          }
        },
        current,
        showToast
      })
    }
  }
}
