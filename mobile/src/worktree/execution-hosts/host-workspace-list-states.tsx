import { Text, View } from 'react-native'
import { CircleAlert, FolderTree, KeyRound, WifiOff } from 'lucide-react-native'
import { MobileNoMatchState, MobileStateView } from '../../components/feedback/MobileStateView'
import { spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../theme/themed-styles'
import {
  isConnectionOutage,
  verdictDisplayLabel
} from '../../transport/connection/connection-health'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import {
  selectHostWorkspaceListState,
  type HostWorkspaceListStateInput
} from './host-workspace-list-state'

export function HostWorkspaceListStates(
  props: HostWorkspaceListStateInput & {
    search: string
    activeFilterCount: number
    bottomInset: number
    /** A search's paused bots the Bot options hide, when nothing else matched. */
    pausedBotMatches?: number
    onShowPausedBots?: () => void
    onClearSearch: () => void
    onReconnect: (() => void) | null
    onRetryPairing: (() => void) | null
    /** Starts a workspace; absent while one can't start here. */
    onNewWorkspace: (() => void) | null
    onClearFilters: () => void
    onRetryLoad: () => void
    onRepair: () => void
  }
) {
  const t = useMobileTranslation()
  const { bottomInset } = props
  const state = selectHostWorkspaceListState(props)
  if (state === 'auth-failed') {
    return (
      <MobileStateView
        icon={KeyRound}
        title={t('worktree.hostWorkspaceListStates.pairingRefused', 'Pairing was refused')}
        message={t(
          'worktree.hostWorkspaceListStates.pairAgain',
          'Pair again from Orca on your computer.'
        )}
        action={{
          label: t('components.authFailedBannerActions.repair', 'Re-pair'),
          onPress: props.onRepair
        }}
        // A refusal can be a passing one (#5200): Retry is worth one tap before pairing again.
        secondaryAction={
          props.onRetryPairing
            ? { label: t('common.retry', 'Retry'), onPress: props.onRetryPairing }
            : null
        }
        bottomInset={bottomInset}
      />
    )
  }
  if (state === 'loading') {
    return (
      <MobileStateView
        loading
        title={t('worktree.hostWorkspaceListStates.loading', 'Loading workspaces…')}
        bottomInset={bottomInset}
      />
    )
  }
  if (state === 'unreachable') {
    const { connectionVerdict } = props
    return (
      <MobileStateView
        icon={WifiOff}
        title={verdictDisplayLabel(connectionVerdict, t)}
        message={
          (isConnectionOutage(connectionVerdict) ? connectionVerdict.detail : undefined) ??
          t(
            'worktree.hostWorkspaceListStates.checkHost',
            'Check that your computer is awake and Orca is running'
          )
        }
        action={
          props.onReconnect
            ? { label: t('common.offline.reconnect', 'Reconnect'), onPress: props.onReconnect }
            : null
        }
        bottomInset={bottomInset}
      />
    )
  }
  if (state === 'catalog-error') {
    return (
      <MobileStateView
        icon={CircleAlert}
        title={t('worktree.hostWorkspaceListStates.loadFailed', 'Couldn’t load workspaces')}
        details={props.catalogError}
        action={{ label: t('common.retry', 'Retry'), onPress: props.onRetryLoad }}
        bottomInset={bottomInset}
      />
    )
  }
  if (state === 'empty') {
    const paused = props.pausedBotMatches ?? 0
    return props.search ? (
      paused > 0 && props.onShowPausedBots ? (
        <MobileNoMatchState
          message={t('bots.search.pausedMatches', '{{count}} paused matches', {
            count: paused,
            defaultValue_one: '{{count}} paused match'
          })}
          onClear={props.onShowPausedBots}
          clearLabel={t('bots.search.showPausedAction', 'Show paused')}
          bottomInset={bottomInset}
        />
      ) : (
        <MobileNoMatchState onClear={props.onClearSearch} bottomInset={bottomInset} />
      )
    ) : (
      <MobileStateView
        icon={FolderTree}
        title={
          props.activeFilterCount > 0
            ? t('worktree.hostWorkspaceListStates.noFilterMatches', 'No workspaces match filters')
            : t('worktree.hostWorkspaceListStates.empty', 'No workspaces')
        }
        action={
          props.activeFilterCount > 0
            ? {
                label: t('worktree.hostWorkspaceListStates.clearFilters', 'Clear filters'),
                onPress: props.onClearFilters
              }
            : props.onNewWorkspace
              ? {
                  label: t('hostScreen.hostBottomBar.newWorkspace', 'New workspace'),
                  onPress: props.onNewWorkspace
                }
              : null
        }
        bottomInset={bottomInset}
      />
    )
  }
  return null
}

/** A list this page cannot build; shown above the rows it already holds, so it never blanks. */
export function HostWorkspaceListReopen({ aboveRows }: { aboveRows: boolean }) {
  const t = useMobileTranslation()
  const styles = useThemedStyles(stylesSheet)
  return (
    <View style={aboveRows ? styles.aboveRows : styles.centered}>
      <Text style={styles.emptyText}>
        {t('worktree.hostWorkspaceListStates.reopen', 'Reopen to update')}
      </Text>
      <Text style={styles.catalogErrorDetail}>
        {t(
          'worktree.hostWorkspaceListStates.reopenDetail',
          'This host lists workspaces in a way this page does not know yet.'
        )}
      </Text>
    </View>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center'
  },
  aboveRows: {
    alignItems: 'center',
    paddingVertical: spacing.md
  },
  emptyText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize
  },
  catalogErrorDetail: {
    marginTop: spacing.xs,
    paddingHorizontal: spacing.lg,
    color: colors.textMuted,
    fontSize: typography.metaSize,
    textAlign: 'center'
  }
}))
