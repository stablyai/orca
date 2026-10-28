import { useCallback } from 'react'
import { View, Text, Pressable } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { ChevronLeft, Folder, MoreHorizontal, PanelLeftOpen } from 'lucide-react-native'
import { MobileSourceControlButton } from './MobileSourceControlButton'
import { MobileSessionHeaderIconButton } from './MobileSessionHeaderIconButton'
import { MobileSessionTabStrip } from './MobileSessionTabStrip'
import { StatusDot } from '../components/StatusDot'
import { styles } from './mobile-session-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useHostSidebarReveal } from '../layout/host-sidebar-reveal'
import { useResponsiveLayout } from '../layout/responsive-layout'
import type { MobileSessionController } from './use-mobile-session-controller'

export function MobileSessionHeader({
  controller,
  backInRail
}: {
  controller: MobileSessionController
  backInRail: boolean
}) {
  useMobileColorScheme()
  const {
    hostId,
    client,
    worktreeId,
    prIsGithubRepo,
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
    terminalSummary,
    handlePanelTap,
    showHeaderMoreButton
  } = controller
  const openSourceControl = useCallback(() => handlePanelTap('sourceControl'), [handlePanelTap])
  const revealSidebar = useHostSidebarReveal()
  // Why: a sideways phone is ~390pt tall, so the tabs share the top bar instead of taking a second row.
  const hasTabs = visibleTabs.length > 0
  const tabsInTopBar = useResponsiveLayout().isLandscapePhone && hasTabs
  const tabStrip = hasTabs ? (
    <MobileSessionTabStrip controller={controller} inTopBar={tabsInTopBar} />
  ) : null
  return (
    <SafeAreaView style={styles.sessionChrome} edges={['top']}>
      <View style={styles.sessionTopBar}>
        {revealSidebar ? (
          <MobileSessionHeaderIconButton
            accessibilityLabel="Show sidebar"
            icon={PanelLeftOpen}
            onPress={revealSidebar}
          />
        ) : null}
        {backInRail ? null : (
          <MobileSessionHeaderIconButton
            accessibilityLabel="Back to worktrees"
            icon={ChevronLeft}
            onPress={requestLeaveSession}
          />
        )}

        <View
          style={[styles.sessionTitleBlock, tabsInTopBar && styles.sessionTitleBlockBesideTabs]}
        >
          <Text style={styles.sessionTitle} numberOfLines={1}>
            {worktreeName || 'Terminal'}
          </Text>
          <Pressable
            style={styles.sessionMetaRow}
            disabled={!showConnectionRetry}
            onPress={() => {
              if (hostId && forceReconnectHost) {
                void forceReconnectHost(hostId)
              }
            }}
            accessibilityRole={showConnectionRetry ? 'button' : undefined}
            accessibilityLabel={showConnectionRetry ? 'Reconnect to desktop' : undefined}
          >
            <StatusDot state={presentedConnState} />
            <Text style={styles.sessionMetaText} numberOfLines={1}>
              {terminalSummary}
            </Text>
          </Pressable>
        </View>
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
          <MobileSourceControlButton
            client={client}
            worktreeId={worktreeId}
            enabled={prIsGithubRepo}
            active={activePanel === 'sourceControl'}
            onPress={openSourceControl}
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
