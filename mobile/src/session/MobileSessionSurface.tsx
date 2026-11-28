import { useCallback, useEffect, useMemo } from 'react'
import { View } from 'react-native'
import { stylesSheet } from './mobile-session-styles'
import { useThemedStyles } from '../theme/themed-styles'
import type { MobileSessionController } from './use-mobile-session-controller'
import { MobileSessionContentRow } from './MobileSessionContentRow'
import { MobileSessionHeader } from './MobileSessionHeader'
import { MobileSessionSheets } from './MobileSessionSheets'
import { MobileWorkerAutoCloseStrip } from './tabs/MobileWorkerAutoCloseStrip'
import { BotChatOpenContext, BotItemOpenContext, BotPanelOpenContext } from '../bots/bot-item-open'
import { openBotChatTab } from './bot-chat-tab-open'
import { useResponsiveLayout } from '../layout/responsive-layout'
import { MobileSessionSidebar } from './tabs/MobileSessionSidebar'
import { MobileSessionSidebarStage } from './tabs/MobileSessionSidebarStage'
import { useMobileSessionSidebar } from './tabs/use-mobile-session-sidebar'
import { SidebarPageDragContext } from './tabs/sidebar-page-drag'
import { useMobileSessionTabSummaryChannel } from './tabs/use-mobile-session-tab-summaries'
import { useSessionRouteRequest } from './use-session-route-request'

export function MobileSessionSurface({ controller }: { controller: MobileSessionController }) {
  const styles = useThemedStyles(stylesSheet)
  const { setMobileSessionRootRef } = controller
  const layout = useResponsiveLayout()
  const { itemsOnPhone, openBotPanel, openNativeSession, worktreeId, sessionTabs } = controller
  const { switchSessionTab, activeSessionTabId, routeBot } = controller
  const homeChatId = routeBot?.bot.chatSessionId
  // From the wide layout up the sidebar docks as a column; a phone, sideways too, slides the session aside.
  const sidebar = useMobileSessionSidebar(layout.isWideLayout)
  const summaries = useMobileSessionTabSummaryChannel()
  // A notification naming a tab here lands on that tab, not behind the sidebar.
  const paneRequest = useSessionRouteRequest('paneKey')
  const { open: sidebarOpen, docked: sidebarDocked, close: closeSidebar } = sidebar
  useEffect(() => {
    if (paneRequest && sidebarOpen && !sidebarDocked) {
      closeSidebar()
    }
  }, [paneRequest])
  const connectionIssue =
    controller.presentedConnState !== 'connected' ||
    controller.connectionEscalated ||
    controller.showConnectionRetry
  const openItem = useMemo(
    () => (itemsOnPhone ? (itemUid: string) => openBotPanel({ item: itemUid }) : null),
    [itemsOnPhone, openBotPanel]
  )
  const routeBotId = routeBot?.bot.id
  // Keyed on the ids, so an Activity read that changes none doesn't redraw every card using the opener.
  const automationIds = (routeBot?.activity?.automations ?? [])
    .map((row) => row.automation.id)
    .join('\n')
  const panelOpener = useMemo(
    () =>
      itemsOnPhone && routeBotId
        ? {
            botId: routeBotId,
            open: openBotPanel,
            automationIds: new Set(automationIds.split('\n'))
          }
        : null,
    [itemsOnPhone, routeBotId, openBotPanel, automationIds]
  )
  const openChat = useCallback(
    (chat: { chatId: string; home?: true }) =>
      openBotChatTab(
        { chatId: chat.chatId, home: chat.home === true },
        {
          homeChatId,
          sessionTabs,
          activeSessionTabId,
          switchSessionTab,
          openNativeSession,
          worktreeId
        }
      ),
    [homeChatId, sessionTabs, activeSessionTabId, switchSessionTab, openNativeSession, worktreeId]
  )
  return (
    <View ref={setMobileSessionRootRef} style={styles.container}>
      <MobileSessionSidebarStage
        sidebar={sidebar}
        cardLabel={controller.activeSessionTab?.title || controller.worktreeName}
        panel={
          <MobileSessionSidebar
            controller={controller}
            sidebar={sidebar}
            summaries={summaries}
            place={controller.terminalSummary}
            connectionIssue={connectionIssue}
          />
        }
      >
        <View style={styles.kavInner}>
          <MobileSessionHeader
            controller={controller}
            homeChatId={homeChatId ?? null}
            summaries={summaries}
            sidebar={sidebar}
            connectionIssue={connectionIssue}
          />
          <MobileWorkerAutoCloseStrip controller={controller} />
          {/* A chat's item chips open the item's page in the bot panel. */}
          <BotItemOpenContext.Provider value={openItem}>
            <BotChatOpenContext.Provider value={openChat}>
              <BotPanelOpenContext.Provider value={panelOpener}>
                <SidebarPageDragContext.Provider value={sidebar.pageDrag}>
                  <MobileSessionContentRow controller={controller} />
                </SidebarPageDragContext.Provider>
              </BotPanelOpenContext.Provider>
            </BotChatOpenContext.Provider>
          </BotItemOpenContext.Provider>
        </View>
      </MobileSessionSidebarStage>
      <MobileSessionSheets controller={controller} />
    </View>
  )
}
