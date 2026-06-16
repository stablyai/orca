import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { colors } from '../theme/mobile-theme'
import { useMobileSourceControlState } from './use-mobile-source-control-state'
import { useMobileSourceControlActionSheet } from './use-mobile-source-control-action-sheet'
import { MobileSourceControlHeader } from './MobileSourceControlHeader'
import { MobileSourceControlContent } from './MobileSourceControlContent'
import { MobileSourceControlModals } from './MobileSourceControlModals'
import { styles } from './mobile-source-control-styles'

export type MobileSourceControlPanelProps = {
  hostId: string
  worktreeId: string
  name?: string
  /** Where the panel was launched from; drives the file-open dismissal path. */
  origin?: string
  embedded?: boolean
  onRequestClose?: () => void
}

export function MobileSourceControlPanel({
  hostId,
  worktreeId,
  name = '',
  origin = '',
  embedded = false,
  onRequestClose
}: MobileSourceControlPanelProps) {
  const state = useMobileSourceControlState({
    hostId,
    worktreeId,
    name,
    origin,
    embedded,
    onRequestClose
  })
  const actionSheetActions = useMobileSourceControlActionSheet(state)
  const {
    connState,
    forceReconnect,
    router,
    setRootRef,
    worktreeLabel,
    screenState,
    busyAction,
    openingPath,
    openingBranchPath,
    loadStatus
  } = state
  const ioBusy = busyAction !== null || openingPath !== null || openingBranchPath !== null

  // Embedded mode docks beside the terminal: close the dock instead of popping
  // a route, and skip the full-screen safe-area chrome (the dock column owns it).
  const onBack = embedded ? () => onRequestClose?.() : () => router.back()
  const header = (
    <MobileSourceControlHeader
      embedded={embedded}
      worktreeLabel={worktreeLabel}
      ioBusy={ioBusy}
      onBack={onBack}
      onRefresh={() => void loadStatus()}
    />
  )

  return (
    <View ref={setRootRef} style={styles.container}>
      {embedded ? (
        <View style={styles.header}>{header}</View>
      ) : (
        <SafeAreaView style={styles.header} edges={['top']}>
          {header}
        </SafeAreaView>
      )}

      {screenState.kind === 'loading' ? (
        <View style={styles.state}>
          <ActivityIndicator size="small" color={colors.textSecondary} />
        </View>
      ) : screenState.kind === 'error' || screenState.kind === 'unavailable' ? (
        <View style={styles.state}>
          <Text style={styles.stateTitle}>
            {screenState.kind === 'unavailable' ? 'Source Control Unavailable' : 'Unable to Load'}
          </Text>
          <Text style={styles.stateText}>{screenState.message}</Text>
          {screenState.kind === 'error' ? (
            <Pressable
              style={styles.retryButton}
              onPress={() => {
                // Why: retrying the request is useless while the transport's
                // reconnect loop is parked at its give-up cap — revive the
                // connection instead (issue #5049). loadStatus re-runs via
                // its connState effect once the new client connects.
                if (connState !== 'connected' && hostId) {
                  void forceReconnect(hostId)
                  return
                }
                void loadStatus()
              }}
            >
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
          ) : null}
        </View>
      ) : (
        <MobileSourceControlContent
          state={state}
          hostId={hostId}
          worktreeId={worktreeId}
          name={name}
        />
      )}

      <MobileSourceControlModals
        state={state}
        worktreeId={worktreeId}
        actionSheetActions={actionSheetActions}
      />
    </View>
  )
}
