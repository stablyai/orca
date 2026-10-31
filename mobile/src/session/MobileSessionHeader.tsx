import { useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { ChevronLeft, GitBranch, MoreHorizontal, PanelLeftOpen } from 'lucide-react-native'
import { NavBar } from '../components/nav-bar/NavBar'
import { NavBarButton } from '../components/nav-bar/NavBarButton'
import { MobileSessionHeaderMoreMenu } from './MobileSessionHeaderMoreMenu'
import { MobileSessionTabStrip } from './MobileSessionTabStrip'
import { MobileSessionTitleBlock } from './MobileSessionTitleBlock'
import type { SessionTitleCard } from './use-session-title-card'
import { styles } from './mobile-session-styles'
import { spacing } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useHostSidebarReveal } from '../layout/host-sidebar-reveal'
import { useResponsiveLayout } from '../layout/responsive-layout'
import type { MobileSessionController } from './use-mobile-session-controller'
import { useTopChromeSpace } from '../layout/use-top-chrome-space'
import { useShellSideRail } from '../layout/use-shell-side-rail'
import { useReleasedSideInset } from '../layout/released-side-inset'
import { sideStripPadding } from './session-side-strip-inset'

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
    isFolderWorkspaceRoute,
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
    handlePanelTap
  } = controller
  const layout = useResponsiveLayout()
  const [headerWidth, setHeaderWidth] = useState<number | null>(null)
  const moreRef = useRef<View>(null)
  const revealSidebar = useHostSidebarReveal()
  const topChrome = useTopChromeSpace()
  const sideRail = useShellSideRail()
  const releasedStrip = useReleasedSideInset()
  // Why: a sideways phone is ~390pt tall, so the tabs share the top bar instead of taking a second row.
  const hasTabs = visibleTabs.length > 0
  const tabsInTopBar = (layout.isLandscapePhone || sideRail) && hasTabs
  // Bar buttons otherwise leave less than two readable tabs on a narrow header.
  const actionsCollapsed = tabsInTopBar && (headerWidth ?? layout.width) < 600
  const sourceControlInBar =
    !isFolderWorkspaceRoute && !isFloatingWorkspaceRoute && !actionsCollapsed
  const tabStrip = hasTabs ? (
    <MobileSessionTabStrip
      controller={controller}
      inTopBar={tabsInTopBar}
      details={details.tabDetails}
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
          },
          // The background reaches the Duo's status column; tabs and buttons stay clear of it.
          sideStripPadding(releasedStrip)
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
