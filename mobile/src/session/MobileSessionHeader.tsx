import { View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { ChevronLeft, Folder, GitBranch, MoreHorizontal, PanelLeftOpen } from 'lucide-react-native'
import { MobileSessionHeaderIconButton } from './MobileSessionHeaderIconButton'
import { MobileSessionTabStrip } from './MobileSessionTabStrip'
import { MobileSessionTitleBlock } from './MobileSessionTitleBlock'
import { styles } from './mobile-session-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useHostSidebarReveal } from '../layout/host-sidebar-reveal'
import type { SessionTitleCard } from './use-session-title-card'
import type { MobileSessionController } from './use-mobile-session-controller'

export function MobileSessionHeader({
  controller,
  details,
  backInRail
}: {
  controller: MobileSessionController
  details: SessionTitleCard
  backInRail: boolean
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
    terminalSummary,
    handlePanelTap,
    showHeaderMoreButton
  } = controller
  const revealSidebar = useHostSidebarReveal()
  const hasTabs = visibleTabs.length > 0
  const tabsInTopBar = details.besideTabs
  const tabStrip = hasTabs ? (
    <MobileSessionTabStrip controller={controller} inTopBar={tabsInTopBar} details={details} />
  ) : null
  return (
    <SafeAreaView style={styles.sessionChrome} edges={['top']}>
      <View ref={details.barRef} onLayout={details.onAnchorLayout} style={styles.sessionTopBar}>
        {revealSidebar ? (
          <MobileSessionHeaderIconButton
            accessibilityLabel={t('session.header.showSidebar', 'Show sidebar')}
            icon={PanelLeftOpen}
            onPress={revealSidebar}
          />
        ) : null}
        {backInRail ? null : (
          <MobileSessionHeaderIconButton
            ref={details.backRef}
            accessibilityLabel={t('session.header.backToWorktrees', 'Back to worktrees')}
            icon={ChevronLeft}
            onPress={() => {
              if (!details.closeFirst()) {
                requestLeaveSession()
              }
            }}
          />
        )}

        <MobileSessionTitleBlock
          title={worktreeName || t('session.header.terminalTitle', 'Terminal')}
          connState={presentedConnState}
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
            accessibilityLabel={t('session.header.openFileExplorer', 'Open file explorer')}
            icon={Folder}
            onPress={() => handlePanelTap('files')}
          />
        )}
        {!isFolderWorkspaceRoute && !isFloatingWorkspaceRoute && (
          <MobileSessionHeaderIconButton
            active={activePanel === 'sourceControl'}
            accessibilityLabel={t('session.header.openSourceControl', 'Open source control')}
            icon={GitBranch}
            onPress={() => handlePanelTap('sourceControl')}
          />
        )}
        {showHeaderMoreButton ? (
          <MobileSessionHeaderIconButton
            active={activePanel === 'pr'}
            accessibilityLabel={t('session.header.moreActions', 'More session actions')}
            icon={MoreHorizontal}
            onPress={() => setShowHeaderMoreActions(true)}
          />
        ) : null}
      </View>

      {tabsInTopBar ? null : tabStrip}
    </SafeAreaView>
  )
}
