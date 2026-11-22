import { useState, useSyncExternalStore } from 'react'
import { StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import {
  ChevronLeft,
  GitBranch,
  ListChecks,
  MoreHorizontal,
  PanelLeftOpen
} from '../components/icons/app-icons'
import { MobileBotAvatar } from '../bots/MobileBotAvatar'
import { NavBar, NavBarRefreshLine } from '../components/nav-bar/NavBar'
import { useRefreshHint } from '../query/refresh-hint'
import { NavBarButton } from '../components/nav-bar/NavBarButton'
import { useSessionMoreMenuGroups } from './MobileSessionHeaderMoreMenu'
import { NativeMenu } from '../components/menu/NativeMenu'
import { MobileBotItemsStrip } from '../bots/items/MobileBotItemsStrip'
import { MobileSourceControlButton } from './MobileSourceControlButton'
import { MobileSessionTabBar } from './tabs/MobileSessionTabBar'
import { MobileSessionTitleBlock } from './MobileSessionTitleBlock'
import type { SessionTitleCard } from './tabs/use-session-title-card'
import { styles } from './mobile-session-styles'
import { colors, spacing } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useHostSidebarReveal } from '../layout/host-sidebar-reveal'
import { useResponsiveLayout } from '../layout/responsive-layout'
import type { MobileSessionController } from './use-mobile-session-controller'
import { useTopChromeSpace } from '../layout/use-top-chrome-space'
import { useShellSideRail } from '../layout/use-shell-side-rail'
import { usePageHeaderClaim } from '../platform/page-header/page-header-claim'

export function MobileSessionHeader({
  controller,
  details
}: {
  controller: MobileSessionController
  details: SessionTitleCard
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const {
    hostId,
    worktreeId,
    isFloatingWorkspaceRoute,
    presentedConnState,
    forceReconnectHost,
    worktreeName,
    activePanel,
    requestLeaveSession,
    visibleTabs,
    showConnectionRetry,
    connectionEscalated,
    terminalSummary,
    handlePanelTap,
    routeBot,
    botStatus,
    itemsOnPhone,
    botPanel,
    openBotPanel,
    sessionTabs,
    activeSessionTabId,
    terminalResume,
    connState
  } = controller
  // A switched-back terminal shows its last screen at once; only a slow catch-up shows the refresh line.
  const catchingUp = useSyncExternalStore(terminalResume.subscribe, terminalResume.anyCatchingUp)
  // While offline the header already says so; a resume queued for the reconnect isn't a refresh.
  const showRefreshLine = useRefreshHint(catchingUp && connState === 'connected')
  const layout = useResponsiveLayout()
  const [headerWidth, setHeaderWidth] = useState<number | null>(null)
  const revealSidebar = useHostSidebarReveal()
  const topChrome = useTopChromeSpace()
  const sideRail = useShellSideRail()
  // Why: a sideways phone is ~390pt tall, so the tabs share the top bar instead of taking a second row.
  const hasTabs = visibleTabs.length > 0
  const tabsInTopBar = (layout.isLandscapePhone || sideRail) && hasTabs
  // Bar buttons otherwise leave the tab bar too narrow to read on a narrow header.
  const actionsCollapsed = tabsInTopBar && (headerWidth ?? layout.width) < 600
  // A bot's screen has no source control (its home isn't a repository): Items takes its place.
  const itemsInBar = itemsOnPhone && routeBot !== null
  const homeChatId = routeBot?.bot.chatSessionId
  const activeTab = sessionTabs.find((tab) => tab.id === activeSessionTabId)
  const onHomeChat =
    homeChatId !== undefined &&
    homeChatId !== null &&
    activeTab?.type === 'agent-session' &&
    activeTab.sessionId === homeChatId
  const sourceControlInBar = !isFloatingWorkspaceRoute && !actionsCollapsed && !itemsInBar
  const tabStrip = hasTabs ? (
    <MobileSessionTabBar
      controller={controller}
      inTopBar={tabsInTopBar}
      actionsCollapsed={actionsCollapsed}
    />
  ) : null
  const title = routeBot
    ? routeBot.bot.name
    : worktreeName || t('session.header.terminalTitle', 'Terminal')
  const leave = () => {
    if (!details.closeFirst()) {
      requestLeaveSession()
    }
  }
  const itemsLabel =
    itemsInBar && routeBot.needsYou > 0
      ? t('session.header.itemsNeedYou', 'Items, {{count}} need you', {
          count: routeBot.needsYou
        })
      : t('session.header.items', 'Items')
  const moreLabel = t('session.header.moreActions', 'More session actions')
  const moreGroups = useSessionMoreMenuGroups(controller, actionsCollapsed)
  // Sideways or beside the sidebar the tabs share the bar, so it stays the page's own.
  const native = usePageHeaderClaim(
    tabsInTopBar || layout.isWideLayout
      ? null
      : {
          title,
          onBack: leave,
          actions: [
            ...(itemsInBar
              ? [
                  {
                    id: 'items',
                    icon: ListChecks,
                    label: itemsLabel,
                    onPress: () => openBotPanel({ tab: 'items' })
                  }
                ]
              : []),
            ...(sourceControlInBar
              ? [
                  {
                    id: 'sourceControl',
                    icon: GitBranch,
                    label: t('session.header.openSourceControl', 'Open source control'),
                    onPress: () => handlePanelTap('sourceControl')
                  }
                ]
              : []),
            { id: 'more', icon: MoreHorizontal, label: moreLabel, menu: moreGroups }
          ]
        }
  )
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
        ref={details.backRef}
        onPress={leave}
      />
    </>
  )
  const titleBlock =
    !sideRail || !hasTabs || showConnectionRetry || connectionEscalated ? (
      <MobileSessionTitleBlock
        title={title}
        leading={routeBot ? <MobileBotAvatar avatar={routeBot.avatar} size={18} /> : undefined}
        connState={presentedConnState}
        details={details}
        meta={botStatus && presentedConnState === 'connected' ? botStatus.line : terminalSummary}
        centered={!tabsInTopBar}
        showConnectionRetry={showConnectionRetry}
        onRetry={() => {
          if (hostId && forceReconnectHost) {
            void forceReconnectHost(hostId)
          }
        }}
      />
    ) : null
  const trailing = (
    <>
      {itemsInBar ? (
        <NavBarButton
          active={botPanel !== null}
          accessibilityLabel={itemsLabel}
          icon={ListChecks}
          badge={{ count: routeBot.needsYou, color: colors.agentQuestion }}
          onPress={() => openBotPanel({ tab: 'items' })}
        />
      ) : null}
      {sourceControlInBar ? (
        <MobileSourceControlButton
          hostId={hostId}
          worktreeId={worktreeId}
          active={activePanel === 'sourceControl'}
          onPress={() => handlePanelTap('sourceControl')}
        />
      ) : null}
      <NativeMenu groups={moreGroups} onOpenChange={controller.setShowHeaderMoreActions}>
        {(openMenu) => (
          <NavBarButton
            active={
              activePanel !== null && !(sourceControlInBar && activePanel === 'sourceControl')
            }
            accessibilityLabel={moreLabel}
            icon={MoreHorizontal}
            onPress={openMenu}
          />
        )}
      </NativeMenu>
    </>
  )
  return (
    <View ref={topChrome.ref} onLayout={topChrome.onLayout}>
      <SafeAreaView
        style={[
          styles.sessionChrome,
          topChrome.space && {
            paddingLeft: topChrome.space.left,
            paddingRight: topChrome.space.right,
            minHeight: topChrome.space.minHeight
          }
        ]}
        edges={topChrome.space ? [] : ['top']}
      >
        <View
          // Sideways the row is a different bar, so rotating measures a fresh one.
          key={tabsInTopBar ? 'tab-row' : 'nav-bar'}
          ref={details.barRef}
          style={tabsInTopBar ? styles.sessionTopBar : undefined}
          onLayout={(event) => {
            details.onAnchorLayout()
            const width = event.nativeEvent.layout.width
            setHeaderWidth((previous) => (previous === width ? previous : width))
          }}
        >
          {tabsInTopBar ? (
            // NavBar centres its title; sideways, the tabs take the row's spare width instead.
            <>
              <View style={barStyles.group}>{leading}</View>
              {titleBlock}
              {tabStrip}
              <View style={barStyles.group}>{trailing}</View>
            </>
          ) : native ? (
            // The shell's bar holds the title; the status line with Reconnect shows here while it matters.
            showConnectionRetry || connectionEscalated ? (
              <View style={barStyles.statusRow}>{titleBlock}</View>
            ) : null
          ) : (
            <NavBar
              leading={leading}
              center={titleBlock}
              trailing={trailing}
              style={barStyles.inChrome}
            />
          )}
        </View>
        {itemsInBar && onHomeChat ? (
          <MobileBotItemsStrip
            count={routeBot.needsYou}
            onView={() => openBotPanel({ tab: 'items' })}
          />
        ) : null}
        {tabsInTopBar ? null : tabStrip}
        {showRefreshLine ? <NavBarRefreshLine /> : null}
      </SafeAreaView>
    </View>
  )
}

const barStyles = StyleSheet.create({
  group: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.xs
  },
  statusRow: {
    alignItems: 'center',
    paddingVertical: spacing.xs
  },
  // The session chrome already draws the background and the line under the tabs.
  inChrome: {
    backgroundColor: 'transparent',
    borderBottomWidth: 0
  }
})
