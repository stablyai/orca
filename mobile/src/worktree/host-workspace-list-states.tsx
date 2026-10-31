import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { FolderPlus } from 'lucide-react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
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
    /** Offered only when nothing is filtered out, so it reads as "this host has no projects yet". */
    onAddProject?: () => void
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
    const unfiltered = !props.search && props.activeFilterCount === 0
    return (
      <View style={styles.centered}>
        <Text style={styles.emptyText}>
          {props.search
            ? t('worktree.hostWorkspaceListStates.noMatches', 'No matching workspaces')
            : props.activeFilterCount > 0
              ? t('worktree.hostWorkspaceListStates.noFilterMatches', 'No workspaces match filters')
              : t('worktree.hostWorkspaceListStates.empty', 'No workspaces')}
        </Text>
        {unfiltered && props.onAddProject ? (
          <Pressable
            style={({ pressed }) => [styles.addProjectButton, pressed && styles.pressed]}
            onPress={props.onAddProject}
            accessibilityRole="button"
          >
            <FolderPlus size={16} color={colors.textPrimary} />
            <Text style={styles.addProjectText}>
              {t('worktree.hostWorkspaceListStates.addProject', 'Add a project')}
            </Text>
          </Pressable>
        ) : null}
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
  addProjectButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.control,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  addProjectText: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '500'
  },
  pressed: {
    opacity: 0.7
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
