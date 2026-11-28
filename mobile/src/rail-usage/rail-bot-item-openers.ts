import { useEffect, useRef } from 'react'
import { chatPaneKey } from '../../../src/shared/agent-session/view/structured-agent-session-projection'
import type { BotChatTreeWorker } from '../../../src/shared/bots/bot-chat-tree'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId
} from '../../../src/shared/execution-host/execution-host'
import { botHomeWorktreeId } from '../bots/host-bots-read'
import { openBotItemWorker } from '../bots/items/bot-item-worker-open'
import { useOpenBotHome } from '../bots/use-open-bot-home'
import { openMobileStructuredSession } from '../session/native-chat/agent-session/open-mobile-structured-session'
import { botCardChatOpener } from '../session/native-chat/transcript/bot-cards/mobile-bot-card-chat-open'
import { useOpenMobileSession } from '../session/use-open-mobile-session'
import type { RailBotTarget } from './rail-bot-targets'

/** Opens a bot's chat or linked worker from the rail Items sheet, closing the sheet first. */
export function useRailBotItemOpeners({
  onClose,
  showToast
}: {
  onClose: () => void
  showToast: (message: string) => void
}) {
  const openMobileSession = useOpenMobileSession()
  const openBotHome = useOpenBotHome()
  const cancelRef = useRef<(() => void) | null>(null)
  useEffect(() => () => cancelRef.current?.(), [])

  const openChat = (target: RailBotTarget | undefined, chatId: string, home: boolean): void => {
    cancelRef.current?.()
    onClose()
    if (!target) {
      return
    }
    const place = { pairedHostId: target.pairedHostId, executionHost: target.executionHost }
    if (home) {
      openBotHome(place, target.bot)
      return
    }
    const opener = botCardChatOpener({
      ready: async (bot, id, current) =>
        target.client
          ? openMobileStructuredSession({
              client: target.client,
              current,
              source: {
                kind: 'history',
                structuredSession: { sessionId: id, workspaceId: botHomeWorktreeId(bot) }
              }
            })
          : { kind: 'superseded' },
      show: (bot, id, opened) =>
        openMobileSession({
          hostId: target.pairedHostId,
          worktreeId: opened.worktreeId,
          paneKey: chatPaneKey(id),
          name: bot.name,
          ...(target.executionHost === LOCAL_EXECUTION_HOST_ID
            ? {}
            : { executionHost: target.executionHost })
        }),
      home: (bot) => openBotHome(place, bot)
    })
    cancelRef.current = opener.cancel
    opener.open(target.bot, chatId)
  }

  const openWorker = (
    target: RailBotTarget | undefined,
    worker: BotChatTreeWorker,
    current: () => boolean
  ): void => {
    if (!target) {
      return
    }
    cancelRef.current?.()
    openBotItemWorker(worker, {
      client: target.client,
      loaded: [],
      open: (found) => {
        if (!found.worktreeId) {
          return
        }
        onClose()
        const workerHost = parseExecutionHostId(found.hostId)
        const executionHost =
          workerHost?.kind === 'runtime' && target.executionHost === LOCAL_EXECUTION_HOST_ID
            ? workerHost.id
            : target.executionHost
        openMobileSession({
          hostId: target.pairedHostId,
          worktreeId: found.worktreeId,
          ...(found.paneKey ? { paneKey: found.paneKey } : {}),
          ...(executionHost !== LOCAL_EXECUTION_HOST_ID ? { executionHost } : {})
        })
      },
      current,
      showToast
    })
  }

  return { openChat, openWorker }
}
