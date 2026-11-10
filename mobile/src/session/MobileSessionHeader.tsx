import { useRef, useState, useSyncExternalStore } from 'react'
import { StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { ChevronLeft, GitBranch, MoreHorizontal, PanelLeftOpen } from 'lucide-react-native'
import { NavBar, NavBarRefreshLine } from '../components/nav-bar/NavBar'
import { useRefreshHint } from '../query/refresh-hint'
import { NavBarButton } from '../components/nav-bar/NavBarButton'
import { MobileSessionHeaderMoreMenu } from './MobileSessionHeaderMoreMenu'
import { MobileSessionTabBar } from './tabs/MobileSessionTabBar'
import { MobileSessionTitleBlock } from './MobileSessionTitleBlock'
import type { SessionTitleCard } from './tabs/use-session-title-card'
import { styles } from './mobile-session-styles'
import { spacing } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useHostSidebarReveal } from '../layout/host-sidebar-reveal'
import { useResponsiveLayout } from '../layout/responsive-layout'
import type { MobileSessionController } from './use-mobile-session-controller'
import { useTopChromeSpace } from '../layout/use-top-chrome-space'
import { useShellSideRail } from '../layout/use-shell-side-rail'

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
    isFloatingWorkspaceRoute,
    presentedConnState,
    forceReconnectHost,
    worktreeName,
    activePanel,
    setShowHeaderMoreActions,
    requestLeaveSession,
    visibleTabs,
    showConnectionRetry,
    connectionEscalated,
    terminalSummary,
    handlePanelTap,
    terminalResume,
    connState
  } = controller
  // A switched-back terminal shows its last screen at once; only a slow catch-up shows the refresh line.
  const catchingUp = useSyncExternalStore(terminalResume.subscribe, terminalResume.anyCatchingUp)
  // While offline the header already says so; a resume queued for the reconnect isn't a refresh.
  const showRefreshLine = useRefreshHint(catchingUp && connState === 'connected')
  const layout = useResponsiveLayout()
  const [headerWidth, setHeaderWidth] = useState<number | null>(null)
  const moreRef = useRef<View>(null)
  const revealSidebar = useHostSidebarReveal()
  const topChrome = useTopChromeSpace()
  const sideRail = useShellSideRail()
  // Why: a sideways phone is ~390pt tall, so the tabs share the top bar instead of taking a second row.
  const hasTabs = visibleTabs.length > 0
  const tabsInTopBar = (layout.isLandscapePhone || sideRail) && hasTabs
  // Bar buttons otherwise leave the tab bar too narrow to read on a narrow header.
  const actionsCollapsed = tabsInTopBar && (headerWidth ?? layout.width) < 600
  const sourceControlInBar = !isFloatingWorkspaceRoute && !actionsCollapsed
  const tabStrip = hasTabs ? (
    <MobileSessionTabBar
      controller={controller}
      inTopBar={tabsInTopBar}
      actionsCollapsed={actionsCollapsed}
    />
  ) : null
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
        onPress={() => {
          if (!details.closeFirst()) {
            requestLeaveSession()
          }
        }}
      />
    </>
  )
  const titleBlock =
    !sideRail || !hasTabs || showConnectionRetry || connectionEscalated ? (
      <MobileSessionTitleBlock
        title={worktreeName || t('session.header.terminalTitle', 'Terminal')}
        connState={presentedConnState}
        details={details}
        meta={terminalSummary}
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
      {sourceControlInBar ? (
        <NavBarButton
          active={activePanel === 'sourceControl'}
          accessibilityLabel={t('session.header.openSourceControl', 'Open source control')}
          icon={GitBranch}
          onPress={() => handlePanelTap('sourceControl')}
        />
      ) : null}
      <NavBarButton
        ref={moreRef}
        active={activePanel !== null && !(sourceControlInBar && activePanel === 'sourceControl')}
        accessibilityLabel={t('session.header.moreActions', 'More session actions')}
        icon={MoreHorizontal}
        onPress={() => setShowHeaderMoreActions(true)}
      />
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
          ) : (
            <NavBar
              leading={leading}
              center={titleBlock}
              trailing={trailing}
              style={barStyles.inChrome}
            />
          )}
        </View>
        {tabsInTopBar ? null : tabStrip}
        {showRefreshLine ? <NavBarRefreshLine /> : null}
      </SafeAreaView>
      <MobileSessionHeaderMoreMenu
        controller={controller}
        anchorRef={moreRef}
        actionsCollapsed={actionsCollapsed}
      />
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
  // The session chrome already draws the background and the line under the tabs.
  inChrome: {
    backgroundColor: 'transparent',
    borderBottomWidth: 0
  }
})
