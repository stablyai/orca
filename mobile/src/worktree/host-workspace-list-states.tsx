import { Text, View } from 'react-native'
import { CircleAlert, FolderTree, WifiOff } from 'lucide-react-native'
import { MobileNoMatchState, MobileStateView } from '../components/MobileStateView'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { isConnectionOutage, verdictDisplayLabel } from '../transport/connection-health'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import {
  selectHostWorkspaceListState,
  type HostWorkspaceListStateInput
} from './host-workspace-list-state'

export function HostWorkspaceListStates(
  props: HostWorkspaceListStateInput & {
    search: string
    activeFilterCount: number
    bottomInset: number
    onClearSearch: () => void
    onReconnect: (() => void) | null
  }
) {
  const t = useMobileTranslation()
  const { bottomInset } = props
  const state = selectHostWorkspaceListState(props)
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
        title={verdictDisplayLabel(connectionVerdict)}
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
        title={t(
          'worktree.hostWorkspaceListStates.loadFailed',
          'Could not load workspaces from this host'
        )}
        message={t(
          'worktree.hostWorkspaceListStates.retryingAutomatically',
          'Retrying automatically.'
        )}
        details={props.catalogError}
        bottomInset={bottomInset}
      />
    )
  }
  if (state === 'empty') {
    return props.search ? (
      <MobileNoMatchState
        message={t('worktree.hostWorkspaceListStates.noMatches', 'No matching workspaces')}
        onClear={props.onClearSearch}
        bottomInset={bottomInset}
      />
    ) : (
      <MobileStateView
        icon={FolderTree}
        title={
          props.activeFilterCount > 0
            ? t('worktree.hostWorkspaceListStates.noFilterMatches', 'No workspaces match filters')
            : t('worktree.hostWorkspaceListStates.empty', 'No workspaces')
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
  useMobileColorScheme()
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

const styles = themedStyleSheet(() => ({
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
