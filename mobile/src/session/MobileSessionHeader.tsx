import { View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { ChevronLeft, Folder, GitBranch, MoreHorizontal, PanelLeftOpen } from 'lucide-react-native'
import { MobileSessionHeaderIconButton } from './MobileSessionHeaderIconButton'
import { MobileSessionTabStrip } from './MobileSessionTabStrip'
import { MobileSessionTitleBlock } from './MobileSessionTitleBlock'
import { styles } from './mobile-session-styles'
import { useHostSidebarReveal } from '../layout/host-sidebar-reveal'
import type { SessionTitleCard } from './use-session-title-card'
import type { MobileSessionController } from './use-mobile-session-controller'

export function MobileSessionHeader({
  controller,
  details
}: {
  controller: MobileSessionController
  details: SessionTitleCard
}) {
  const {
    hostId,
    isFolderWorkspaceRoute,
    isFloatingWorkspaceRoute,
    connState,
    forceReconnectHost,
    worktreeName,
    activePanel,
    setShowHeaderMoreActions,
    requestLeaveSession,
    visibleTabs,
    showConnectionRetry,
    terminalSummary,
    handlePanelTap,
    showHeaderMoreButton
  } = controller
  const revealSidebar = useHostSidebarReveal()
  const hasTabs = visibleTabs.length > 0
  const tabsInTopBar = details.besideTabs
  const tabStrip = hasTabs ? (
    <MobileSessionTabStrip controller={controller} inTopBar={tabsInTopBar} />
  ) : null
  return (
    <SafeAreaView style={styles.sessionChrome} edges={['top']}>
      <View ref={details.barRef} onLayout={details.onAnchorLayout} style={styles.sessionTopBar}>
        {revealSidebar ? (
          <MobileSessionHeaderIconButton
            accessibilityLabel="Show sidebar"
            icon={PanelLeftOpen}
            onPress={revealSidebar}
          />
        ) : null}
        <MobileSessionHeaderIconButton
          accessibilityLabel="Back to worktrees"
          icon={ChevronLeft}
          onPress={requestLeaveSession}
        />

        <MobileSessionTitleBlock
          title={worktreeName || 'Terminal'}
          connState={connState}
          details={details}
          meta={terminalSummary}
          showConnectionRetry={showConnectionRetry}
          onRetry={() => {
            if (hostId && forceReconnectHost) {
              void forceReconnectHost(hostId)
            }
          }}
        />
        {tabsInTopBar ? tabStrip : null}
        {!isFloatingWorkspaceRoute && (
          <MobileSessionHeaderIconButton
            active={activePanel === 'files'}
            accessibilityLabel="Open file explorer"
            icon={Folder}
            onPress={() => handlePanelTap('files')}
          />
        )}
        {!isFolderWorkspaceRoute && !isFloatingWorkspaceRoute && (
          <MobileSessionHeaderIconButton
            active={activePanel === 'sourceControl'}
            accessibilityLabel="Open source control"
            icon={GitBranch}
            onPress={() => handlePanelTap('sourceControl')}
          />
        )}
        {showHeaderMoreButton ? (
          <MobileSessionHeaderIconButton
            active={activePanel === 'pr'}
            accessibilityLabel="More session actions"
            icon={MoreHorizontal}
            onPress={() => setShowHeaderMoreActions(true)}
          />
        ) : null}
      </View>

      {tabsInTopBar ? null : tabStrip}
    </SafeAreaView>
  )
}
