import { useRef, useSyncExternalStore } from 'react'
import { StyleSheet, View, type HostInstance } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { GestureDetector } from 'react-native-gesture-handler'
import { ChevronLeft, MoreHorizontal, PanelLeftOpen } from 'lucide-react-native'
import { MobileBotAvatar } from '../bots/MobileBotAvatar'
import { NavBar, NavBarRefreshLine } from '../components/nav-bar/NavBar'
import { useRefreshHint } from '../query/refresh-hint'
import { NavBarButton } from '../components/nav-bar/NavBarButton'
import { MobileSessionHeaderMoreMenu } from './MobileSessionHeaderMoreMenu'
import { MobileSessionTitleBlock } from './MobileSessionTitleBlock'
import { MobileSessionTabMark } from './tabs/MobileSessionTabMark'
import { MobileSessionTabsButton } from './tabs/MobileSessionTabsButton'
import { isForkedChatTab } from './tabs/mobile-session-tab-rows'
import {
  useMobileSessionTabSummaries,
  usePublishTabSummaries,
  type MobileSessionTabSummaryChannel
} from './tabs/use-mobile-session-tab-summaries'
import { useNow } from '../hooks/use-now'
import type { MobileSessionSidebar } from './tabs/use-mobile-session-sidebar'
import { mobileForkAccessibleName } from './fork/mobile-fork-marked-name'
import { stylesSheet } from './mobile-session-styles'
import { useThemedStyles } from '../theme/themed-styles'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useHostSidebarReveal } from '../layout/host-sidebar-reveal'
import type { MobileSessionController } from './use-mobile-session-controller'
import { useTopChromeSpace } from '../layout/use-top-chrome-space'
import { useKeyboardPersistingTaps } from '../platform/keyboard/keyboard-persisting-taps'

/** One 52 pt bar: back, the open tab (the workspace under it), ⋯, and the tab count that opens the sidebar. */
export function MobileSessionHeader({
  controller,
  homeChatId,
  summaries,
  sidebar,
  connectionIssue
}: {
  controller: MobileSessionController
  homeChatId: string | null
  summaries: MobileSessionTabSummaryChannel
  sidebar: MobileSessionSidebar
  /** Something is wrong with the connection, so the subtitle says what instead of the workspace. */
  connectionIssue: boolean
}) {
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const {
    hostId,
    forceReconnectHost,
    worktreeName,
    setShowHeaderMoreActions,
    requestLeaveSession,
    showConnectionRetry,
    terminalSummary,
    routeBot,
    botStatus,
    itemsOnPhone,
    terminalResume,
    connState,
    statusDot,
    nativeChatController,
    activeSessionTabId,
    openSessionTabActionSheetAfterKeyboardDismiss
  } = controller
  // A switched-back terminal shows its last screen at once; only a slow catch-up shows the refresh line.
  const catchingUp = useSyncExternalStore(terminalResume.subscribe, terminalResume.anyCatchingUp)
  // While offline the header already says so; a resume queued for the reconnect isn't a refresh.
  const showRefreshLine = useRefreshHint(catchingUp && connState === 'connected')
  const moreRef = useRef<HostInstance>(null)
  const revealSidebar = useHostSidebarReveal()
  const topChrome = useTopChromeSpace()
  // Why: the first tap must reach the bar with the keyboard open instead of only dismissing it (#5106).
  const keepsKeyboard = useKeyboardPersistingTaps('handled')
  // The clock only re-reads agent states; with no tabs there is nothing to age.
  const now = useNow(60_000, controller.visibleTabs.length > 0)
  const tabs = useMobileSessionTabSummaries(controller, homeChatId, now)
  usePublishTabSummaries(summaries, tabs)
  const active = tabs.find((row) => row.tab.id === activeSessionTabId)
  // On the web a drag's release also clicks the bar control it ended over; that click is the drag's.
  const press = (action: () => void) => () => {
    if (!sidebar.tapIsDragEnd()) {
      action()
    }
  }
  const workspace = routeBot
    ? routeBot.bot.name
    : worktreeName || t('session.header.terminalTitle', 'Terminal')
  // A bot's place line says how it's doing (Paused, Working…), as its header always has.
  const place = routeBot && botStatus ? `${routeBot.bot.name} · ${botStatus.line}` : workspace
  const leading = (
    <>
      {revealSidebar ? (
        <NavBarButton
          accessibilityLabel={t('session.header.showSidebar', 'Show sidebar')}
          icon={PanelLeftOpen}
          onPress={revealSidebar}
        />
      ) : null}
      <NavBarButton
        accessibilityLabel={t('session.header.backToWorktrees', 'Back to worktrees')}
        icon={ChevronLeft}
        onPress={press(requestLeaveSession)}
      />
    </>
  )
  // The tab is the title; with none open, the workspace is.
  const title = active ? (
    <MobileSessionTitleBlock
      title={active.title}
      forked={isForkedChatTab(active.tab)}
      leading={<MobileSessionTabMark row={active} size={16} />}
      subtitle={connectionIssue ? terminalSummary : place}
      status={connectionIssue ? statusDot : null}
      accessibilityLabel={
        isForkedChatTab(active.tab) ? mobileForkAccessibleName(active.title, t) : active.title
      }
      onPress={press(() => openSessionTabActionSheetAfterKeyboardDismiss(active.tab))}
      showConnectionRetry={showConnectionRetry}
      onRetry={retry}
    />
  ) : (
    <MobileSessionTitleBlock
      title={workspace}
      leading={routeBot ? <MobileBotAvatar avatar={routeBot.avatar} size={18} /> : undefined}
      subtitle={routeBot && botStatus && !connectionIssue ? botStatus.line : terminalSummary}
      status={connectionIssue ? statusDot : null}
      accessibilityLabel={workspace}
      showConnectionRetry={showConnectionRetry}
      onRetry={retry}
    />
  )
  function retry() {
    if (hostId && forceReconnectHost) {
      void forceReconnectHost(hostId)
    }
  }
  const trailing = (
    <>
      <NavBarButton
        ref={moreRef}
        accessibilityLabel={t('session.header.moreActions', 'More session actions')}
        icon={MoreHorizontal}
        onPress={press(() => setShowHeaderMoreActions(true))}
      />
      <MobileSessionTabsButton
        tabs={tabs}
        activeTabId={activeSessionTabId}
        // A bot's Items live in the sidebar; what needs you there rings here too.
        alsoNeedYou={itemsOnPhone && routeBot ? routeBot.needsYou : 0}
        active={sidebar.docked && sidebar.open}
        onPress={press(sidebar.toggle)}
      />
    </>
  )
  return (
    <View ref={topChrome.ref} onLayout={topChrome.onLayout}>
      {/* Dragging the bar left opens the sidebar; nothing else in it moves sideways. */}
      <GestureDetector gesture={sidebar.barDrag} touchAction="pan-y">
        <View ref={keepsKeyboard}>
          <SafeAreaView
            style={[
              styles.sessionChrome,
              // A chat is one ground from the top: its header sits on the canvas, with no line under it.
              nativeChatController.showNativeChat && styles.sessionChromeOnChat,
              topChrome.space && {
                paddingLeft: topChrome.space.left,
                paddingRight: topChrome.space.right,
                minHeight: topChrome.space.minHeight
              }
            ]}
            edges={topChrome.space ? [] : ['top']}
          >
            <NavBar
              leading={leading}
              center={title}
              trailing={trailing}
              style={barStyles.inChrome}
            />
            {showRefreshLine ? <NavBarRefreshLine /> : null}
          </SafeAreaView>
        </View>
      </GestureDetector>
      <MobileSessionHeaderMoreMenu controller={controller} anchorRef={moreRef} />
    </View>
  )
}

const barStyles = StyleSheet.create({
  // The session chrome already draws the background and the line under the bar.
  inChrome: {
    backgroundColor: 'transparent',
    borderBottomWidth: 0
  }
})
