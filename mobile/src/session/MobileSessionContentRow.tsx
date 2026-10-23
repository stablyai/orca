import { StyleSheet, View } from 'react-native'
import { Banner } from '../components/ui/Banner'
import { verdictDisplayLabel } from '../transport/connection-health'
import { spacing } from '../theme/mobile-theme'
import { SessionDockColumn } from './SessionDockColumn'
import { dismissMobileSessionCreateWarningState } from './mobile-session-create-warning-state'
import { styles } from './mobile-session-styles'
import type { MobileSessionController } from './use-mobile-session-controller'
import { MobileSessionActiveContent } from './MobileSessionActiveContent'
import { MobileSessionCommandDock } from './MobileSessionCommandDock'

export function MobileSessionContentRow({ controller }: { controller: MobileSessionController }) {
  const {
    hostId,
    worktreeId,
    worktreeName,
    activePanel,
    setActivePanel,
    sessionContentRowWidth,
    canDockPanel,
    setCreateWarningState,
    createWarning,
    handleFileOpenStart,
    handleOpenedFileDiff,
    handleSessionContentRowLayout,
    showConnectionRetry,
    forceReconnectHost,
    connectionVerdict,
    visibleTabs,
    draftStorageFailed,
    dismissDraftStorageFailure
  } = controller
  return (
    <View style={styles.sessionContentRow} onLayout={handleSessionContentRowLayout}>
      <View style={styles.sessionContentMain}>
        {createWarning ? (
          <View style={bannerStyles.slot}>
            <Banner
              tone="warning"
              message={createWarning}
              onDismiss={() => setCreateWarningState(dismissMobileSessionCreateWarningState)}
            />
          </View>
        ) : null}
        {draftStorageFailed ? (
          <View style={bannerStyles.slot}>
            <Banner
              tone="warning"
              title="Command draft not saved"
              message="This phone could not store it. Keep this screen open so you don't lose it."
              onDismiss={dismissDraftStorageFailure}
            />
          </View>
        ) : null}
        {/* Native shells only: on the page the shell owns the connection, so a retry would do nothing. */}
        {showConnectionRetry && hostId && forceReconnectHost && visibleTabs.length > 0 ? (
          <View style={bannerStyles.slot}>
            <Banner
              tone="warning"
              message={verdictDisplayLabel(connectionVerdict)}
              action={{ label: 'Try again', onPress: () => void forceReconnectHost(hostId) }}
            />
          </View>
        ) : null}
        <MobileSessionActiveContent controller={controller} />
        {/* Why: translate instead of resize so keyboard toggles don't trigger a server-side PTY viewport change. */}
        <MobileSessionCommandDock controller={controller} />
      </View>
      {canDockPanel && activePanel !== null && (
        <SessionDockColumn
          activePanel={activePanel}
          hostId={hostId}
          worktreeId={worktreeId}
          name={worktreeName || ''}
          availableWidth={sessionContentRowWidth}
          onRequestClose={() => setActivePanel(null)}
          onFileOpenStart={handleFileOpenStart}
          onOpenedFileDiff={handleOpenedFileDiff}
        />
      )}
    </View>
  )
}

const bannerStyles = StyleSheet.create({
  slot: { paddingTop: spacing.sm, paddingBottom: spacing.xs }
})
