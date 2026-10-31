import { ActivityIndicator, Text, View } from 'react-native'
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
  }
) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const state = selectHostWorkspaceListState(props)
  if (state === 'loading') {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="small" color={colors.textSecondary} />
      </View>
    )
  }
  if (state === 'unreachable') {
    const { connectionVerdict } = props
    return (
      <View style={styles.centered}>
        <Text style={styles.emptyText}>{verdictDisplayLabel(connectionVerdict)}</Text>
        <Text style={styles.catalogErrorDetail}>
          {(isConnectionOutage(connectionVerdict) ? connectionVerdict.detail : undefined) ??
            t(
              'worktree.hostWorkspaceListStates.checkHost',
              'Check that your computer is awake and Orca is running'
            )}
        </Text>
      </View>
    )
  }
  if (state === 'catalog-error') {
    return (
      <View style={styles.centered}>
        <Text style={styles.emptyText}>
          {t(
            'worktree.hostWorkspaceListStates.loadFailed',
            'Could not load workspaces from this host'
          )}
        </Text>
        <Text style={styles.catalogErrorDetail}>
          {t(
            'worktree.hostWorkspaceListStates.retrying',
            'worktree.ps failed ({{error}}) — retrying automatically',
            { error: props.catalogError }
          )}
        </Text>
      </View>
    )
  }
  if (state === 'empty') {
    return (
      <View style={styles.centered}>
        <Text style={styles.emptyText}>
          {props.search
            ? t('worktree.hostWorkspaceListStates.noMatches', 'No matching workspaces')
            : props.activeFilterCount > 0
              ? t('worktree.hostWorkspaceListStates.noFilterMatches', 'No workspaces match filters')
              : t('worktree.hostWorkspaceListStates.empty', 'No workspaces')}
        </Text>
      </View>
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
