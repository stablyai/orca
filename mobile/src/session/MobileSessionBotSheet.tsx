import { appendReturnedDraftText } from '../../../src/shared/native-chat/input/drafts/returned-draft-text'
import { openBotChatTab } from './bot-chat-tab-open'
import { setMobileNativeChatDraftText } from './native-chat/composer/drafts/mobile-native-chat-draft-store'
import { mobileNativeChatScopeKey } from './native-chat/conversation/mobile-native-chat-scope-key'
import { useContext, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { useSessionRouteRequest } from './use-session-route-request'
import { loadMobileNativeChatDrafts } from './native-chat/composer/drafts/mobile-native-chat-draft-persistence'
import { MobileBotPanel } from '../bots/MobileBotPanel'
import { MobileDictationLiveContext } from '../dictation/mobile-dictation-live-context'
import { useMobileDictationLive } from '../dictation/use-mobile-dictation-live'
import { MobileNativeChatDictationPreviewContext } from './native-chat/composer/dictation/mobile-native-chat-dictation-preview-context'
import { BotItemCommentMicContext } from '../bots/items/bot-item-comment-mic'
import { openBotItemFile } from '../bots/items/bot-item-file-open'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useWorkspaceRouteHandoff } from '../navigation/workspace-route-handoff'
import { useRouteHandoff } from '../navigation/route-handoff'
import { hostStackHostRoute } from '../navigation/host-stack-navigation'
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
import { useOpenMobileAutomations } from '../automations/use-open-mobile-automations'
import { useOpenUrlInOrca } from '../browser/tab-navigation/use-open-url-in-orca'
import {
  PhoneConnectTripContext,
  usePhoneConnectTrips,
  type ConnectSignInPage
} from '../bots/connectors/use-phone-connect-trip'
import { MobileConnectSignInSheet } from '../bots/connectors/MobileConnectSignInSheet'
import type { MobileBrowserTab, MobileSessionTab } from './tabs/mobile-session-tabs'

const browserTabOf = (tabs: readonly MobileSessionTab[], browserPageId: string | null) =>
  browserPageId
    ? tabs.find(
        (tab): tab is MobileBrowserTab =>
          tab.type === 'browser' && tab.browserPageId === browserPageId
      )
    : undefined

export function MobileSessionBotSheet({ controller }: { controller: MobileSessionController }) {
  const {
    routeBot,
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
    connState,
    dictation
  } = controller
  const server = useContext(WorkspaceServerContext)
  const router = useWorkspaceRouteHandoff()
  const hostRouter = useRouteHandoff()
  const t = useMobileTranslation()
  const executionHost = useWorkspaceExecutionHost()
  const openMobileSession = useOpenMobileSession()
  const openMobileAutomations = useOpenMobileAutomations()
  // An item's comment box dictates with this screen's one dictation, as its chat composers do.
  const dictationLive = useMobileDictationLive(dictation, controller.cancelDictation, hostId ?? '')
  const { dictationEnabled, dictationMode, handleDictationToggle } = controller
  const { handleDictationPressIn, handleDictationPressOut } = controller
  const { isStarting, isRecording, isProcessing } = dictation
  const mic = useMemo(
    () => ({
      onMicPress: dictationEnabled ? handleDictationToggle : undefined,
      micActive: isStarting || isRecording,
      micStarting: isStarting,
      micProcessing: isProcessing,
      dictationMode,
      onMicPressIn: handleDictationPressIn,
      onMicPressOut: handleDictationPressOut
    }),
    [
      dictationEnabled,
      dictationMode,
      handleDictationPressIn,
      handleDictationPressOut,
      handleDictationToggle,
      isProcessing,
      isRecording,
      isStarting
    ]
  )
  const accessRequests = useBotAccessRequests({
    client,
    routeBot,
    visible: botPanel !== null,
    showToast
  })
  const homeChatId = routeBot?.bot.chatSessionId
  const homeTab = homeChatId
    ? sessionTabs.find((tab) => tab.type === 'agent-session' && tab.sessionId === homeChatId)
    : undefined
  const closePanel = () => setBotPanel(null)
  const startSuggestion =
    homeTab && hostId
      ? (ask: string) => {
          closePanel()
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
  // An opener's draft (Update from Import) waits for the Home Chat's tab and its saved draft, then is spent.
  const homeDraft = useSessionRouteRequest('homeDraft')
  const appliedHomeDraft = useRef<typeof homeDraft>(null)
  const askHomeDraft = useEffectEvent((request: NonNullable<typeof homeDraft>) => {
    if (appliedHomeDraft.current !== request) {
      appliedHomeDraft.current = request
      startSuggestion?.(request.value)
    }
  })
  const homeTabId = homeTab?.id
  useEffect(() => {
    if (!homeDraft?.value || !homeTabId || !hostId || appliedHomeDraft.current === homeDraft) {
      return
    }
    let live = true
    // A write before the saved draft is in outranks it, losing what the owner typed; theirs wins.
    void loadMobileNativeChatDrafts(hostId, worktreeId).then((loaded) => {
      if (live && loaded) {
        askHomeDraft(homeDraft)
      }
    })
    return () => {
      live = false
    }
  }, [homeDraft, homeTabId, hostId, worktreeId])
  const openInOrca = useOpenUrlInOrca(controller)
  const { sessionTabsRef, fetchSessionTabs, openBotPanel } = controller
  // A Connect's sign-in shows in a sheet of its own, or as a new tab when the computer closed the trip's.
  const [signInPageId, setSignInPageId] = useState<string | null>(null)
  const showSignIn = async (page: ConnectSignInPage) => {
    closePanel()
    if (page.browserPageId && !browserTabOf(sessionTabsRef.current, page.browserPageId)) {
      await fetchSessionTabs()
    }
    if (browserTabOf(sessionTabsRef.current, page.browserPageId)) {
      setSignInPageId(page.browserPageId)
    } else {
      openInOrca?.(page.url)
    }
  }
  const connectTrips = usePhoneConnectTrips(client, worktreeId, {
    show: openInOrca ? (page) => void showSignIn(page) : null,
    reopen: (back) => {
      setSignInPageId(null)
      openBotPanel({ settings: back })
    }
  })
  const trip = connectTrips.current
  // Only the waiting trip's own page: one that ended or was replaced meanwhile never shows.
  const signInTrip =
    trip?.trip.status === 'waiting' && trip.trip.page?.browserPageId === signInPageId ? trip : null
  const signInTab = (signInTrip && browserTabOf(sessionTabs, signInPageId)) || null
  if (!routeBot || !itemsOnPhone || !hostId) {
    return null
  }
  const chatTabScope = {
    homeChatId,
    sessionTabs,
    activeSessionTabId,
    switchSessionTab,
    openNativeSession,
    worktreeId
  }
  const openWorkerAt = (worker: BotChatTreeWorker) => {
    if (!worker.worktreeId) {
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
      closePanel()
      openBotChatTab({ chatId: chat.chatId ?? null, home: chat.origin === 'home' }, chatTabScope)
    },
    openWorker: (worker) => {
      closePanel()
      openBotItemWorker(worker, {
        client,
        loaded: [],
        open: openWorkerAt,
        current: () => true,
        showToast
      })
    }
  }
  // Its home workspace went with it, so the host's list is next, as after any removed workspace.
  const leaveDeletedBot = () => {
    closePanel()
    hostRouter.replace(hostStackHostRoute(hostId))
  }
  const home = { folderPath: controller.worktreePath, onDeleted: leaveDeletedBot }
  const newAutomation = nativeChatController.showNativeChat
    ? () => {
        closePanel()
        // The desktop's "New automation" draft, into the bot's chat where automations are made.
        nativeChatController.setChatComposerText((current) =>
          current.trim() ? current : t('bots.automations.newDraft', 'Set up an automation that ')
        )
      }
    : null
  const viewRuns = (automationId: string) => {
    closePanel()
    openMobileAutomations(hostId, {
      automation: automationId,
      ...(executionHost && executionHost !== LOCAL_EXECUTION_HOST_ID
        ? { server: executionHost }
        : {})
    })
  }
  const hostName =
    (server ? server.name : controller.hostName) || t('bots.items.thisComputer', 'The computer')
  return (
    <MobileDictationLiveContext.Provider value={dictationLive}>
      <MobileNativeChatDictationPreviewContext.Provider value={controller.chatDictationPreview}>
        <BotItemCommentMicContext.Provider value={mic}>
          <PhoneConnectTripContext.Provider value={connectTrips}>
            <MobileBotPanel
              open={botPanel}
              onClose={closePanel}
              routeBot={routeBot}
              client={client}
              online={connState === 'connected'}
              hostName={hostName}
              hostId={hostId}
              worktreeId={worktreeId}
              hostKey={hostBotsKey(hostId, executionHost)}
              listNeedsYou={routeBot.needsYou}
              treeActions={treeActions}
              accessRequests={accessRequests}
              onOpenItemChat={(item) => {
                closePanel()
                openBotChatTab(
                  { chatId: item.chat.id, home: item.chat.kind === 'home' },
                  chatTabScope
                )
              }}
              onOpenFile={(path, toast) =>
                openBotItemFile({
                  path,
                  router,
                  hostId,
                  worktreeId,
                  t,
                  toast,
                  onRequestClose: closePanel
                })
              }
              onStartSuggestion={startSuggestion}
              onNewAutomation={newAutomation}
              home={home}
              onAskInChat={startSuggestion}
              onViewRuns={viewRuns}
              signIn={
                <MobileConnectSignInSheet
                  tab={signInTab}
                  source={signInTrip?.source ?? 'linear'}
                  client={client}
                  worktreeId={worktreeId}
                  screencastSupported={controller.browserScreencastSupported}
                  hostSupport={controller.browserHostSupport}
                  onCancel={connectTrips.cancelSignIn}
                />
              }
            />
          </PhoneConnectTripContext.Provider>
        </BotItemCommentMicContext.Provider>
      </MobileNativeChatDictationPreviewContext.Provider>
    </MobileDictationLiveContext.Provider>
  )
}
