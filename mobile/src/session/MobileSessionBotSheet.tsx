import { appendReturnedDraftText } from '../../../src/shared/native-chat/input/drafts/returned-draft-text'
import { openBotChatTab } from './bot-chat-tab-open'
import { setMobileNativeChatDraftText } from './native-chat/composer/drafts/mobile-native-chat-draft-store'
import { mobileNativeChatScopeKey } from './native-chat/conversation/mobile-native-chat-scope-key'
import { useContext } from 'react'
import { MobileBotSheet } from '../bots/MobileBotSheet'
import { MobileBotPanel } from '../bots/MobileBotPanel'
import { navigateToMobileFilePreview } from '../files/preview/mobile-file-preview-navigation'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useWorkspaceRouteHandoff } from '../navigation/workspace-route-handoff'
import { WorkspaceServerContext } from '../worktree/execution-hosts/workspace-server-context'
import { useBotAccessRequests } from '../bots/use-bot-access-requests'
import type { MobileSessionController } from './use-mobile-session-controller'
import { hostBotsKey } from '../bots/host-bots-read'
import { useWorkspaceExecutionHost } from '../navigation/workspace-execution-host'
import { useOpenMobileSession } from './use-open-mobile-session'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId
} from '../../../src/shared/execution-host/execution-host'
import type { BotChatTreeActions } from '../bots/MobileBotChatTree'
import { openBotItemWorker } from '../bots/items/bot-item-worker-open'
import type { BotChatTreeWorker } from '../../../src/shared/bots/bot-chat-tree'

// The desktop's "New automation" drafts this into the bot's chat, where automations are made.
const NEW_AUTOMATION_DRAFT = 'Set up an automation that '

export function MobileSessionBotSheet({ controller }: { controller: MobileSessionController }) {
  const {
    routeBot,
    showBotSheet,
    setShowBotSheet,
    client,
    showToast,
    nativeChatController,
    hostId,
    worktreeId,
    sessionTabs,
    activeSessionTabId,
    switchSessionTab,
    openNativeSession,
    itemsOnPhone,
    botPanel,
    setBotPanel,
    connState
  } = controller
  const server = useContext(WorkspaceServerContext)
  const router = useWorkspaceRouteHandoff()
  const t = useMobileTranslation()
  const executionHost = useWorkspaceExecutionHost()
  const openMobileSession = useOpenMobileSession()
  const accessRequests = useBotAccessRequests({
    client,
    routeBot,
    visible: showBotSheet || botPanel !== null,
    showToast
  })
  if (!routeBot) {
    return null
  }
  const homeChatId = routeBot.bot.chatSessionId
  const homeTab = homeChatId
    ? sessionTabs.find((tab) => tab.type === 'agent-session' && tab.sessionId === homeChatId)
    : undefined
  const chatTabScope = {
    homeChatId,
    sessionTabs,
    activeSessionTabId,
    switchSessionTab,
    openNativeSession,
    worktreeId
  }
  const openWorkerAt = (worker: BotChatTreeWorker) => {
    if (!hostId || !worker.worktreeId) {
      return
    }
    // A worker on another paired server is reachable only when the bot runs on the paired desktop.
    const workerHost = parseExecutionHostId(worker.hostId)
    const host =
      workerHost?.kind === 'runtime' &&
      (executionHost ?? LOCAL_EXECUTION_HOST_ID) === LOCAL_EXECUTION_HOST_ID
        ? workerHost.id
        : executionHost
    openMobileSession({
      hostId,
      worktreeId: worker.worktreeId,
      ...(worker.paneKey ? { paneKey: worker.paneKey } : {}),
      ...(host && host !== LOCAL_EXECUTION_HOST_ID ? { executionHost: host } : {})
    })
  }
  const treeActions: BotChatTreeActions = {
    openChat: (chat) => {
      setShowBotSheet(false)
      openBotChatTab({ chatId: chat.chatId ?? null, home: chat.origin === 'home' }, chatTabScope)
    },
    openWorker: (worker) => {
      if (!hostId) {
        return
      }
      setShowBotSheet(false)
      openBotItemWorker(worker, {
        client,
        loaded: [],
        open: openWorkerAt,
        current: () => true,
        showToast
      })
    }
  }
  const closeSheets = () => {
    setShowBotSheet(false)
    setBotPanel(null)
  }
  const startSuggestion = homeTab
    ? (ask: string) => {
        closeSheets()
        // The Home Chat's own draft, as the desktop does, whichever chat is showing.
        const scope = mobileNativeChatScopeKey(hostId, worktreeId, homeTab.id)
        if (scope) {
          setMobileNativeChatDraftText(scope, (current) => appendReturnedDraftText(current, ask))
        }
        if (activeSessionTabId !== homeTab.id) {
          switchSessionTab(homeTab)
        }
      }
    : null
  const newAutomation = nativeChatController.showNativeChat
    ? () => {
        closeSheets()
        nativeChatController.setChatComposerText((current) =>
          current.trim() ? current : NEW_AUTOMATION_DRAFT
        )
      }
    : null
  if (itemsOnPhone && hostId) {
    const closePanel = () => setBotPanel(null)
    const panelTreeActions: BotChatTreeActions = {
      openChat: (chat) => {
        closePanel()
        treeActions.openChat(chat)
      },
      openWorker: (worker) => {
        closePanel()
        treeActions.openWorker(worker)
      }
    }
    return (
      <MobileBotPanel
        open={botPanel}
        onClose={closePanel}
        routeBot={routeBot}
        client={client}
        online={connState === 'connected'}
        hostName={
          (server ? server.name : controller.hostName) ||
          t('bots.items.thisComputer', 'The computer')
        }
        hostId={hostId}
        worktreeId={worktreeId}
        hostKey={hostBotsKey(hostId, executionHost)}
        listNeedsYou={routeBot.needsYou}
        treeActions={panelTreeActions}
        accessRequests={accessRequests}
        onOpenItemChat={(item) => {
          closePanel()
          openBotChatTab({ chatId: item.chat.id, home: item.chat.kind === 'home' }, chatTabScope)
        }}
        onOpenFile={(path, toast) => {
          // Only a file in the bot's folder opens, as on the desktop.
          if (!isBotFolderPath(path)) {
            toast(t('bots.items.link.fileOutside', "{{path}} isn't in this bot's folder", { path }))
            return
          }
          navigateToMobileFilePreview(
            router,
            {
              hostId,
              worktreeId,
              relativePath: path.replace(/^\.\//, ''),
              name: path.split('/').at(-1) ?? path
            },
            { embedded: true, onRequestClose: closePanel }
          )
        }}
        onStartSuggestion={startSuggestion}
        onNewAutomation={newAutomation}
      />
    )
  }
  return (
    <MobileBotSheet
      hostKey={hostBotsKey(hostId ?? '', executionHost)}
      treeActions={treeActions}
      visible={showBotSheet}
      onClose={() => setShowBotSheet(false)}
      routeBot={routeBot}
      client={client}
      showToast={showToast}
      accessRequests={accessRequests}
      onStartSuggestion={startSuggestion}
      onNewAutomation={newAutomation}
    />
  )
}

/** A link to a file in the bot's folder: relative, never climbing out of it. */
function isBotFolderPath(path: string): boolean {
  return !path.startsWith('/') && !path.startsWith('~') && !path.split(/[\\/]/).includes('..')
}
